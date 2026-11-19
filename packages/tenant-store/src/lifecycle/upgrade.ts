// packages/tenant-store/src/lifecycle/upgrade.ts
//
// The module step of a release: apply the pending migration files of every ENABLED
// enable-gate database `t_<hex32>__<module>`, as the database's owner m_<id>, and give the
// app role its privileges on what those files created.
//
// Why this exists: enableModule migrates a database only when it creates it or restores it.
// A module that is already enabled returns `noop` before any migration runs, so without this
// function no code ever applies a later file to an existing gate database.
//
// What it does for each database, in order:
//   1. the row says `enabled` AND the module's enablement row says `enabled`; every other
//      row is skipped and counted (blocked: Karenz, the release never touches it; enabling,
//      disabling, dropped: not live)
//   2. the module must be in the catalogue of this image (else `unknown_module`) and declare
//      a database (a module without one is never opened)
//   3. the name is recomputed from (customer, module) and must equal the row's db_name, and
//      the server must say the database is owned by m_<id> (as ensureDatabase refuses it)
//   4. openAsOwner proves database and user on a DIRECT pool
//   5. runMigrations as the owner: release label of the tag, phase of a headerless file from
//      the pinned baseline, NO upgradeHooks (the host's dump set is the restore point and the
//      one-shot mounts no dump directory). Nothing pending executes no DDL.
//   6. grantAppPrivileges, so the app role can use the new objects: when a file was applied, or when nothing was
//      pending and a READ-ONLY check finds the app role's privileges incomplete (an earlier run committed files and
//      did not finish the grant). A failing run that had committed files tries it once, best effort, before it
//      reports. The bounds of the runner are the kernel chain's (60 s lock wait, 5 s DDL lock timeout).
// It stops at the first database that fails. It writes no plt row (the platform connection
// only ever sees SELECT), never calls enableModule or disableModule, and never opens a
// database that is not listed `enabled`.
//
// Nothing here puts a module id, database name, customer id or database message into a result
// or a log line: a failure is a code and an ordinal. The caller prints the counts.
import { join } from 'node:path'
import type { Sql } from '@gremion/db'
import { MIGRATION_FILENAME } from '../manifest.js'
import { pinnedPhaseFor, type PhaseFor } from '../phase.js'
import { PINNED_BASELINE } from '../phase-baseline.js'
import { MigrationRunnerError, runMigrations } from '../runner.js'
import { grantAppPrivileges, openAsOwner } from './enable.js'
import { assertTenantModuleTarget, LifecycleError, moduleRoles } from './guards.js'
import { assertPlatform } from './platform.js'
import type { LifecycleModule, ModuleServer } from './types.js'

export interface UpgradeDeps {
  /** A connection to gremion_platform. Only SELECT statements reach it. */
  platform: Sql
  /** The server behind a compose service name (runtime.database.postgresService). */
  server(service: string): ModuleServer
  /** The modules this image carries (loadModuleJsons). */
  catalogue: readonly LifecycleModule[]
  /** The release label of the tag: written into every ledger row this run adds (1-64 characters). */
  releaseRef: string
  /** The phase of a headerless file. Default: the pinned kernel baseline of chain `module-<id>`. */
  phaseFor?: (moduleId: string) => PhaseFor | undefined
  /** Progress, as a line without any name of a module, database or customer. */
  log?: (line: string) => void
  /** How long to wait for another runner's migration lock, in ms. Default 60 s, as the kernel chain's job. */
  lockWaitTimeoutMs?: number
  /** lock_timeout of each file's transaction, in ms. Default 5 s, as the kernel chain's job. */
  ddlLockTimeoutMs?: number
}

/** The kernel chain's bounds (services/kernel-api migrate): a blocked database fails fast and the host retries. */
export const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 60_000
export const DEFAULT_DDL_LOCK_TIMEOUT_MS = 5_000

export interface UpgradeCounts {
  /** Rows skipped plus databases opened (the sum of the four below); a database after a failure is not reached and not counted. */
  total: number
  /** Databases on which at least one file was applied. */
  upgraded: number
  /** Databases opened with nothing pending (a database whose interrupted grant was repaired is counted here too, and in `regranted`). */
  unchanged: number
  /** Rows not opened: every state but `enabled`, an enablement that is not `enabled`, a module without a database. */
  skipped: number
  failed: number
  files_applied: number
}

/**
 * `commit`: the commit's fault (a migration file or the re-grant raised, or the database is not as the platform says).
 * `connection`: a connection-level error BEFORE any DDL on that database, or a lock wait that gave up (the runner's lock
 * wait, a file's DDL lock timeout): never the commit's fault, the host retries.
 */
export type UpgradeFailureKind = 'commit' | 'connection'

export interface UpgradeFailure {
  kind: UpgradeFailureKind
  /** A fixed code: a LifecycleError or MigrationRunnerError code, `unknown_module`, `sql_<SQLSTATE>`, `connection_<code>` or `error`. Never a message. */
  code: string
  /** 1-based position among the databases the loop meant to open. */
  ordinal: number
  /** The migration file the runner named, when it named one. A module's own file name, never customer data. */
  file: string | null
}

export interface UpgradeSummary extends UpgradeCounts {
  /** Databases with nothing pending whose app privileges were found incomplete (an earlier run was interrupted) and re-granted. Not part of the verb's JSON line. */
  regranted: number
  /** What was skipped, by the row's state; `enabled-not-enrolled` and `no-database` are the two skips that are not a state. */
  skippedByState: Record<string, number>
  failure: UpgradeFailure | null
}

/** The SQLSTATEs of a server that is shutting down, not accepting connections yet, or out of disk; class 08 is every connection exception. */
const CONNECTION_SQLSTATES = new Set(['57P01', '57P02', '57P03', '53100'])
const CONNECTION_NODE_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  // postgres.js: a connect that did not finish in time, or a socket that was closed or destroyed before the query ran
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
])

function codeOf(err: unknown): string | null {
  const c = (err as { code?: unknown } | null | undefined)?.code
  return typeof c === 'string' ? c : null
}

/** A code from the connection-level set, on the error, its `cause` chain or an AggregateError's members. */
export function connectionLevelCode(err: unknown, depth = 0): string | null {
  if (err === null || typeof err !== 'object' || depth > 4) return null
  const c = codeOf(err)
  if (c !== null && (c.startsWith('08') || CONNECTION_SQLSTATES.has(c) || CONNECTION_NODE_CODES.has(c))) return c
  for (const inner of (err as { errors?: unknown }).errors instanceof Array ? ((err as { errors: unknown[] }).errors) : []) {
    const found = connectionLevelCode(inner, depth + 1)
    if (found) return found
  }
  return connectionLevelCode((err as { cause?: unknown }).cause, depth + 1)
}

/**
 * A wait for a lock that gave up: the runner's migration-lock wait (LOCK_TIMEOUT) or a file whose DDL lock timed out
 * (55P03 under APPLY_FAILED, the file's transaction rolled back whole). That is contention with the live colour, not a
 * fault of the commit: it is reported as the infrastructure's (the host retries) and files committed before it stay.
 */
function lockContention(err: unknown): boolean {
  // a raw 55P03 can only be the wait for the re-grant lock (grantLocked): the grant's own statements run with no lock_timeout
  if (!(err instanceof MigrationRunnerError)) return codeOf(err) === '55P03'
  if (err.code === 'LOCK_TIMEOUT') return true
  return err.code === 'APPLY_FAILED' && codeOf((err as { cause?: unknown }).cause) === '55P03'
}

/** What a failure of one database is called in a result: a fixed token, never a message. */
function describeFailure(err: unknown): { code: string; file: string | null } {
  if (err instanceof ModuleUpgradeError) return { code: err.code, file: null }
  if (err instanceof MigrationRunnerError) {
    const file = err.files.find((f) => MIGRATION_FILENAME.test(f)) ?? null
    return { code: err.code, file }
  }
  if (err instanceof LifecycleError) return { code: err.code, file: null }
  const conn = connectionLevelCode(err)
  if (conn !== null) return { code: `connection_${conn}`, file: null }
  const code = codeOf(err)
  if (code !== null && /^[0-9A-Z]{5}$/.test(code)) return { code: `sql_${code}`, file: null }
  return { code: 'error', file: null }
}

/** A failure of this module that is not a LifecycleError (the image does not know the module). */
export class ModuleUpgradeError extends Error {
  override name = 'ModuleUpgradeError'
  constructor(
    readonly code: 'unknown_module',
    message: string,
  ) {
    super(message)
  }
}

async function databaseOwnerOf(admin: Sql, dbName: string): Promise<string | null> {
  const rows = await admin<{ owner: string }[]>`
    SELECT r.rolname AS owner FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = ${dbName}`
  return rows[0]?.owner ?? null
}

/**
 * READ-ONLY: is anything grantAppPrivileges would give the app role missing? Compares the same set of schemas
 * (owned by the owner, plus public) and the same grants: schema USAGE, the table privileges, sequence privileges,
 * the default privileges of the owner in each schema, and the ledger staying read-only. A complete database answers
 * false and no DDL follows. Without this, files committed by a run whose grant never finished (or never began) would
 * be left without it for good: the next run applies nothing and would skip the grant.
 */
export async function appPrivilegesMissing(owned: Sql, owner: string, app: string): Promise<boolean> {
  const [r] = await owned<{ missing: boolean }[]>`
    WITH o AS (SELECT oid FROM pg_roles WHERE rolname = ${owner}::name),
    s AS (
      SELECT n.oid, n.nspname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
       WHERE (r.rolname = ${owner}::name OR n.nspname = 'public') AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
    ),
    c AS (
      SELECT s.nspname, rel.oid, rel.relname, rel.relkind
        FROM s JOIN pg_class rel ON rel.relnamespace = s.oid
       WHERE rel.relowner = (SELECT oid FROM o) AND rel.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    )
    SELECT (
      EXISTS (SELECT 1 FROM s WHERE NOT has_schema_privilege(${app}::name, s.oid, 'USAGE'))
      OR EXISTS (
        SELECT 1 FROM c
         WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT (c.nspname = 'public' AND c.relname = 'schema_migrations')
           AND NOT (has_table_privilege(${app}::name, c.oid, 'SELECT')
                    AND (c.relkind NOT IN ('r', 'p') OR (has_table_privilege(${app}::name, c.oid, 'INSERT') AND has_table_privilege(${app}::name, c.oid, 'UPDATE') AND has_table_privilege(${app}::name, c.oid, 'DELETE'))))
      )
      OR EXISTS (
        SELECT 1 FROM c WHERE c.relkind = 'S'
           AND NOT (has_sequence_privilege(${app}::name, c.oid, 'USAGE') AND has_sequence_privilege(${app}::name, c.oid, 'SELECT'))
      )
      OR EXISTS (
        SELECT 1 FROM c
         WHERE c.nspname = 'public' AND c.relname = 'schema_migrations' AND c.relkind = 'r'
           AND (NOT has_table_privilege(${app}::name, c.oid, 'SELECT') OR has_table_privilege(${app}::name, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))
      )
      OR EXISTS (
        SELECT 1 FROM s CROSS JOIN (VALUES ('r'), ('S')) AS k(kind)
         WHERE NOT EXISTS (
           SELECT 1 FROM pg_default_acl d
             CROSS JOIN LATERAL aclexplode(d.defaclacl) a
             JOIN pg_roles g ON g.oid = a.grantee
            WHERE d.defaclrole = (SELECT oid FROM o) AND d.defaclnamespace = s.oid AND d.defaclobjtype = k.kind::"char" AND g.rolname = ${app}::name
         )
      )
    ) AS missing`
  return r?.missing === true
}

/** The name behind the advisory lock key of the re-grant (hashtextextended); the integration test takes the same lock. */
export const GRANT_LOCK_NAME = 'gremion.module-upgrade.grant'

/**
 * The re-grant of one database, serialised by a session advisory lock of its own. The runner releases ITS lock before
 * the grant begins, so a run that waited for it finds nothing pending while the winner is still granting: without this
 * lock its privilege check would see the winner's half-done grant as an interrupted one and grant at the same time
 * (concurrent GRANTs on one object collide). With it, the second run waits here and, with `onlyIfMissing`, checks AGAIN
 * under the lock. Returns whether a grant ran. A wait past `waitMs` raises 55P03 before any DDL of this run's own.
 */
async function grantLocked(owned: Sql, owner: string, app: string, waitMs: number, onlyIfMissing: boolean): Promise<boolean> {
  const conn = await owned.reserve()
  let locked = false
  try {
    await conn`SELECT set_config('lock_timeout', ${String(waitMs)}, false)`
    await conn`SELECT pg_advisory_lock(hashtextextended(${GRANT_LOCK_NAME}, 0))`
    locked = true
    // the grant's own statements wait as long as they must: only the wait for this lock is bounded
    await conn`SELECT set_config('lock_timeout', '0', false)`
    const handle = conn as unknown as Sql
    if (onlyIfMissing && !(await appPrivilegesMissing(handle, owner, app))) return false
    await grantAppPrivileges(handle, owner, app)
    return true
  } finally {
    try {
      if (locked) await conn`SELECT pg_advisory_unlock(hashtextextended(${GRANT_LOCK_NAME}, 0))`
      else await conn`SELECT set_config('lock_timeout', '0', false)`
    } catch {
      // a dead connection holds nothing; the pool is ended by the caller, which drops a session lock too
    } finally {
      conn.release()
    }
  }
}

export interface UpgradeRow {
  customerId: string
  moduleKey: string
  dbName: string
}

export interface UpgradeOneResult {
  /** The files this run applied, in order. */
  applied: number
  /** Nothing was pending, but the app role's privileges were incomplete and were re-granted. */
  regranted: boolean
}

/** A database that went wrong, with how far it got; the loop turns it into a failure. */
export class ModuleDatabaseFailure extends Error {
  constructor(
    readonly original: unknown,
    readonly kind: UpgradeFailureKind,
    readonly filesApplied: number,
  ) {
    super('database upgrade failed')
  }
}

/**
 * Upgrades ONE enabled gate database. Throws a ModuleDatabaseFailure (kind and files applied so far) on any failure;
 * the caller owns the counting. `ModuleServer` handles come from `deps.server`.
 */
export async function upgradeModuleDatabase(row: UpgradeRow, deps: Pick<UpgradeDeps, 'server' | 'catalogue' | 'releaseRef' | 'phaseFor' | 'log' | 'lockWaitTimeoutMs' | 'ddlLockTimeoutMs'>): Promise<UpgradeOneResult> {
  // progress.ddl is false while nothing on this database has been written or can have been (a connection-level
  // failure then is the infrastructure's); true once the runner is about to begin a file's transaction, or the re-grant runs.
  const progress = { ddl: false }
  let filesApplied = 0
  try {
    const module = deps.catalogue.find((m) => m.id === row.moduleKey)
    if (!module) throw new ModuleUpgradeError('unknown_module', 'the module is not in this image\'s catalogue')
    const database = module.moduleJson.runtime.database
    if (!database) throw new LifecycleError('INVALID_INPUT', 'the module declares no database')
    // the name is recomputed, never trusted from the row
    const dbName = assertTenantModuleTarget(row.dbName, row.customerId, module.id)
    const { owner, app } = moduleRoles(module.id)
    const server = deps.server(database.postgresService)
    const current = await databaseOwnerOf(server.admin, dbName)
    if (current === null) throw new LifecycleError('DATABASE_MISSING', 'plt.module_database says the database is enabled but the server has no such database')
    if (current !== owner) throw new LifecycleError('DATABASE_FOREIGN_OWNER', `the database is owned by ${current}, not ${owner}: refusing to migrate a database the lifecycle did not create`)
    const owned = await openAsOwner(server, dbName, owner)
    try {
      const phaseFor = deps.phaseFor ? deps.phaseFor(module.id) : pinnedPhaseFor(`module-${module.id}`, PINNED_BASELINE)
      const grantWaitMs = deps.lockWaitTimeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS
      const r = await runMigrations({
        sql: owned,
        dir: join(module.dir, database.migrations),
        releaseRef: deps.releaseRef,
        // Bounded like the kernel chain: a lock queued behind one live transaction would block every later reader of
        // that table on the old colour, so an ALTER gives up fast (host retry) instead of waiting minutes.
        lockWaitTimeoutMs: deps.lockWaitTimeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS,
        ddlLockTimeoutMs: deps.ddlLockTimeoutMs ?? DEFAULT_DDL_LOCK_TIMEOUT_MS,
        ...(phaseFor ? { phaseFor } : {}),
        // Observation only, NOT an upgrade hook: no dump, nothing refused. preApply runs immediately before a file's
        // transaction, so after it a connection error may have come from inside DDL.
        hooks: { preApply: () => void (progress.ddl = true) },
        // The runner's lines name only files of the module's own chain; any other line (a lock wait names sessions) is dropped.
        log: (line) => {
          const m = /^applied (\S+)$/.exec(line)
          if (m && MIGRATION_FILENAME.test(m[1]!)) {
            filesApplied += 1
            deps.log?.(line)
          }
        },
      }).catch(async (err: unknown) => {
        // The runner commits each file on its own: when it throws after some committed (a later file failed, the unlock
        // failed), those files are live and the grant has not run. Try it once, best effort, before the failure is
        // reported; the next run's privilege check repairs it if this one cannot. It never replaces the runner's error.
        if (filesApplied > 0) {
          progress.ddl = true
          await grantLocked(owned, owner, app, grantWaitMs, false).catch(() => {})
        }
        throw err
      })
      filesApplied = r.applied.length
      let regranted = false
      if (r.applied.length > 0) {
        progress.ddl = true
        await grantLocked(owned, owner, app, grantWaitMs, false)
      } else if (await appPrivilegesMissing(owned, owner, app)) {
        // Nothing pending, but an earlier run committed files and never finished the grant (it failed, a later file
        // failed, or the one-shot was killed): repair it now. A database that is complete runs no DDL at all.
        progress.ddl = true
        regranted = await grantLocked(owned, owner, app, grantWaitMs, true)
      }
      return { applied: r.applied.length, regranted }
    } finally {
      await owned.end({ timeout: 5 }).catch(() => {})
    }
  } catch (err) {
    // exit-3 class is an allow-list: a lock wait that gave up, or a connection-level code (on the error or on the cause
    // the runner wrapped it with: LEDGER_FORMAT of the ledger read, UNLOCK_FAILED of a clean run) while NO DDL was begun.
    // APPLY_FAILED is the commit's whatever its cause (a file's transaction had begun; the runner raises it only after
    // preApply, which sets progress.ddl, and it is excluded here as well so the rule does not rest on that order).
    const applyFailed = err instanceof MigrationRunnerError && err.code === 'APPLY_FAILED'
    const infra = lockContention(err) || (!progress.ddl && !applyFailed && connectionLevelCode(err) !== null)
    throw new ModuleDatabaseFailure(err, infra ? 'connection' : 'commit', filesApplied)
  }
}

const ENABLED = 'enabled'

/**
 * The whole step: lists plt.module_database (SELECT only), skips and counts every row that is not live, and upgrades
 * the live ones in a fixed order (module key, then customer id), stopping at the first database that fails.
 * Returns the counts; it throws only for what is not a database's failure (a missing environment value for a module
 * server, a platform that cannot be read for a reason other than its connection).
 */
export async function upgradeModuleDatabases(deps: UpgradeDeps): Promise<UpgradeSummary> {
  const summary: UpgradeSummary = { total: 0, upgraded: 0, unchanged: 0, skipped: 0, failed: 0, files_applied: 0, regranted: 0, skippedByState: {}, failure: null }
  const skip = (why: string) => {
    summary.skipped += 1
    summary.total += 1
    summary.skippedByState[why] = (summary.skippedByState[why] ?? 0) + 1
  }
  let rows: { customer_id: string; module_key: string; db_name: string; state: string; enablement_state: string | null }[]
  try {
    await assertPlatform(deps.platform)
    rows = await deps.platform`
      SELECT d.customer_id::text AS customer_id, m.module_key AS module_key, d.db_name AS db_name,
             d.state AS state, e.state AS enablement_state
        FROM plt.module_database d
        JOIN plt.module m ON m.module_id = d.module_id
        LEFT JOIN plt.module_enablement e ON e.customer_id = d.customer_id AND e.module_id = d.module_id
       ORDER BY m.module_key, d.customer_id`
  } catch (err) {
    if (connectionLevelCode(err) !== null) {
      summary.failure = { kind: 'connection', code: describeFailure(err).code, ordinal: 0, file: null }
      return summary
    }
    throw err
  }

  const live: typeof rows = []
  for (const row of rows) {
    if (row.state !== ENABLED) skip(row.state)
    else if (row.enablement_state !== ENABLED) skip('enabled-not-enrolled')
    else if (deps.catalogue.find((m) => m.id === row.module_key)?.moduleJson.runtime.database === null) skip('no-database')
    else live.push(row)
  }

  // Every module server this run needs is resolved BEFORE the first database is opened: a missing environment value
  // is a precondition (the caller's usage error), not a failure half way through a customer list.
  for (const service of new Set(live.map((r) => deps.catalogue.find((m) => m.id === r.module_key)?.moduleJson.runtime.database?.postgresService).filter((s): s is string => !!s))) {
    deps.server(service)
  }

  let ordinal = 0
  for (const row of live) {
    ordinal += 1
    try {
      const r = await upgradeModuleDatabase({ customerId: row.customer_id, moduleKey: row.module_key, dbName: row.db_name }, deps)
      summary.total += 1
      summary.files_applied += r.applied
      if (r.applied > 0) summary.upgraded += 1
      else summary.unchanged += 1
      if (r.regranted) summary.regranted += 1
    } catch (err) {
      const failure = err instanceof ModuleDatabaseFailure ? err : new ModuleDatabaseFailure(err, 'commit', 0)
      const { code, file } = describeFailure(failure.original)
      summary.total += 1
      summary.failed += 1
      summary.files_applied += failure.filesApplied
      summary.failure = { kind: failure.kind, code, ordinal, file }
      return summary
    }
  }
  return summary
}
