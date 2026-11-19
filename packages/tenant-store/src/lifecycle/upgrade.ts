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
//   6. only when a file was applied: grantAppPrivileges, so the app role can use the new objects
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
}

export interface UpgradeCounts {
  /** Rows skipped plus databases opened (the sum of the four below); a database after a failure is not reached and not counted. */
  total: number
  /** Databases on which at least one file was applied. */
  upgraded: number
  /** Databases opened with nothing pending. */
  unchanged: number
  /** Rows not opened: every state but `enabled`, an enablement that is not `enabled`, a module without a database. */
  skipped: number
  failed: number
  files_applied: number
}

/**
 * `commit`: the commit's fault (a migration file or the re-grant raised, or the database is not as the platform says).
 * `connection`: a connection-level error BEFORE any DDL on that database (never the commit's fault: the host retries).
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

export interface UpgradeRow {
  customerId: string
  moduleKey: string
  dbName: string
}

export interface UpgradeOneResult {
  /** The files this run applied, in order. */
  applied: number
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
export async function upgradeModuleDatabase(row: UpgradeRow, deps: Pick<UpgradeDeps, 'server' | 'catalogue' | 'releaseRef' | 'phaseFor' | 'log'>): Promise<UpgradeOneResult> {
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
      const r = await runMigrations({
        sql: owned,
        dir: join(module.dir, database.migrations),
        releaseRef: deps.releaseRef,
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
      })
      filesApplied = r.applied.length
      if (r.applied.length > 0) {
        progress.ddl = true
        await grantAppPrivileges(owned, owner, app)
      }
      return { applied: r.applied.length }
    } finally {
      await owned.end({ timeout: 5 }).catch(() => {})
    }
  } catch (err) {
    // exit-3 class is an allow-list: a connection-level code AND no DDL begun AND not an error the runner
    // itself built (APPLY_FAILED is the commit's, whatever its cause)
    const infra = !progress.ddl && !(err instanceof MigrationRunnerError) && connectionLevelCode(err) !== null
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
  const summary: UpgradeSummary = { total: 0, upgraded: 0, unchanged: 0, skipped: 0, failed: 0, files_applied: 0, skippedByState: {}, failure: null }
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
