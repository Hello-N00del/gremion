// packages/tenant-store/src/runner.ts
//
// The one migration runner (DL-001) for one (tenant, module) database. It
// replaces the leaf ledgers, and gremion-ui's db.ts / control-migrations.ts
// runners when those adopt it (TASK-077/084); there is no boot migration.
//
// Order of a run, and why:
//   1. reserve ONE connection (sql.reserve()); every step below runs on it.
//   2. refuse a pooler (Q3): a session advisory lock does not survive
//      PgBouncer transaction pooling (assertNotPooler says how it is told).
//   3. pg_advisory_lock(ADVISORY_LOCKS.migration) — BEFORE schema_migrations
//      is read. Read-then-lock lets two runners both see the same pending
//      set; the second waits here instead (bounded by lockWaitTimeoutMs,
//      logging who holds it), then reads a ledger that already has
//      everything.
//   4. verify the WHOLE manifest (every file, both directions, every sha256)
//      and prepare every pending body (stripOuterTransaction) — pure, no DDL.
//   5. read the ledger WITHOUT DDL (to_regclass) and check it against the
//      manifest: an applied file whose bytes no longer match the sha256 the
//      ledger recorded, or a ledger row with no file, aborts here — tamper
//      after apply is caught before any DDL too.
//   6. refuse a pending file that sorts below the highest applied one (Q4),
//      and resolve every pending file's phase (TASK-075, TRD-361): its
//      `-- gremion:phase` header, else options.phaseFor (the baseline of
//      files locked before the header existed), else PHASE_MISSING -- all
//      before any hook, dump or DDL.
//   7. per pending file: hooks.preApply (under the lock, before the file's
//      transaction), then ONE transaction holding the file's body and its
//      ledger row (G-078). The ledger table itself is created inside the first
//      file's transaction, so a run that applies nothing executes no DDL; a
//      ledger a pre-TASK-075 runner wrote (no phase/release_ref/contract_after)
//      is upgraded in that same transaction (upgradeLedger), never refused.
//   8. finally: pg_advisory_unlock, then release the connection.
import type { Sql } from '@gremion/db'
import type postgres from 'postgres'
import { ADVISORY_LOCKS } from './advisory-locks.js'
import { compareMigrationFiles, MIGRATION_FILENAME, readVerifiedUnion } from './manifest.js'
import { PhaseError, resolvePhase, type PhaseErrorCode, type PhaseFor, type PhaseInfo } from './phase.js'
import { stripOuterTransaction } from './strip-outer-transaction.js'

type Reserved = postgres.ReservedSql<{}>

export interface PreApplyContext {
  /** The reserved, lock-holding connection. Not inside a transaction. */
  sql: Reserved
  /** The first (for a single-dir run, the only) migrations directory. */
  dir: string
  /** Every migrations directory of this run (TASK-077 G3 b), in the order given. Always set by runMigrations. */
  dirs?: readonly string[]
  /** The ledger table this run writes, schema-qualified (TASK-077 G3 a). Always set by runMigrations. */
  ledger?: string
  /** Files already in the ledger when this run took the lock. */
  applied: readonly string[]
  /** Every file this run will apply, in order. */
  pending: readonly string[]
}

export interface RunMigrationsHooks {
  /**
   * Called under the lock, before each pending file's transaction (TASK-029,
   * TASK-075). If it throws, the run aborts: that file and every later one
   * are not applied.
   */
  preApply?(file: string, ctx: PreApplyContext): void | Promise<void>
}

export interface RunMigrationsOptions {
  /** A DIRECT connection to the (tenant, module) database, never a pooler. */
  sql: Sql
  /** The module's migrations directory, holding manifest.json. Exactly one of dir / dirs. */
  dir?: string
  /**
   * TASK-077 G3(b): a chain spanning several directories (TASK-029 register
   * dirs[]), each holding its own manifest.json. Applied as ONE sequence in
   * migration-number order; a filename or number in two dirs is refused
   * (DUPLICATE_MIGRATION) before anything runs.
   */
  dirs?: readonly string[]
  /**
   * TASK-077 G3(a): the ledger table, schema-qualified (`schema.table`, plain
   * lower-case identifiers). Default `public.schema_migrations`. A run that
   * creates the ledger issues `CREATE SCHEMA IF NOT EXISTS <schema>` first, in
   * the same transaction as the first file.
   */
  ledger?: string
  /**
   * The release this run ships (e.g. dist-v1.2.3, or import-<job>): written
   * into every ledger row it adds (release_ref, 1-64 characters).
   */
  releaseRef: string
  /**
   * The phase of a file whose first line declares none: the baseline of files
   * locked before the header existed (pinnedPhaseFor over PINNED_BASELINE). Undefined for a
   * file it does not know, which is then PHASE_MISSING.
   */
  phaseFor?: PhaseFor
  hooks?: RunMigrationsHooks
  log?: (line: string) => void
  /**
   * How long to wait for another runner's migration lock, in ms (0 = no
   * limit). Default 10 minutes; past it the run fails with LOCK_TIMEOUT.
   */
  lockWaitTimeoutMs?: number
  /**
   * lock_timeout for each file's transaction (SET LOCAL), so an ALTER TABLE
   * waiting on a busy table fails instead of queueing every runtime query
   * behind it. Default: the server's setting.
   */
  ddlLockTimeoutMs?: number
}

export interface RunMigrationsResult {
  applied: string[]
  alreadyApplied: number
}

export type MigrationRunnerErrorCode =
  | 'POOLER_TARGET'
  | 'LOCK_NOT_HELD'
  | 'LOCK_TIMEOUT'
  | 'LEDGER_FORMAT'
  | 'LEDGER_UNKNOWN_FILE'
  | 'LEDGER_HASH_MISMATCH'
  | 'OUT_OF_ORDER'
  | PhaseErrorCode
  | 'PRE_APPLY_FAILED'
  | 'APPLY_FAILED'
  | 'TRANSACTION_ESCAPED'
  | 'UNLOCK_FAILED'

export class MigrationRunnerError extends Error {
  override name = 'MigrationRunnerError'
  constructor(
    readonly code: MigrationRunnerErrorCode,
    message: string,
    readonly files: readonly string[] = [],
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/** The default ledger (every chain before TASK-077). */
export const LEDGER = 'public.schema_migrations'

/** `schema.table`, each part a plain lower-case identifier (no quoting needed, none accepted). */
const LEDGER_NAME = /^([a-z_][a-z0-9_]{0,62})\.([a-z_][a-z0-9_]{0,62})$/

export interface LedgerName {
  /** `schema.table` as given (to_regclass / ::regclass text). */
  text: string
  schema: string
  table: string
  /** `"schema"."table"`, safe to interpolate into SQL text. */
  quoted: string
}

/**
 * TASK-077 G3(a): validates a ledger name. Throws a TypeError naming the rule
 * on anything but `schema.table` of plain identifiers, so a ledger name can
 * never carry SQL into the runner's or the gate's statements.
 */
export function ledgerName(ledger: string = LEDGER): LedgerName {
  const m = typeof ledger === 'string' ? LEDGER_NAME.exec(ledger) : null
  if (!m) throw new TypeError(`ledger must be schema.table of plain lower-case identifiers (got ${JSON.stringify(ledger)})`)
  return { text: ledger, schema: m[1]!, table: m[2]!, quoted: `"${m[1]}"."${m[2]}"` }
}

// phase / release_ref: SCHEMA 148-160 (DB-<CTX>-SCHEMA-MIGRATION).
// contract_after [A] (TASK-075 Q8, a SCHEMA deviation filed for a doc patch):
// the release after which a contract may run, so the serving colour's gate
// can accept a contract it survives (schema-gate.ts, state 'ahead').
// Constraint names follow the table (for the default ledger they are the
// pre-TASK-077 names, schema_migrations_*).
function ledgerDdl(l: LedgerName): string {
  return `CREATE TABLE ${l.quoted} (
  filename       text PRIMARY KEY CHECK (filename ~ '${MIGRATION_FILENAME.source.replaceAll("'", "''")}'),
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  phase          text NOT NULL CHECK (phase IN ('expand', 'migrate', 'contract')),
  release_ref    text NOT NULL CHECK (char_length(release_ref) BETWEEN 1 AND 64),
  contract_after text NULL,
  CONSTRAINT ${l.table}_contract_after_check CHECK ((phase = 'contract') = (contract_after IS NOT NULL))
)`
}

/** The ledger columns TASK-075 added; a ledger without them predates this runner. */
const LEDGER_COLUMNS = ['phase', 'release_ref', 'contract_after'] as const

/** release_ref of a row a pre-TASK-075 runner applied (backfilled by the ledger upgrade). */
export const PRE_TASK_075_RELEASE_REF = 'pre-task-075'

/**
 * TASK-075 r2: brings a pre-TASK-075 ledger to LEDGER_DDL's shape, inside the
 * first pending file's transaction (so after the chain check and the dump,
 * and rolled back with that file). Every existing row gets the phase the run
 * resolved for its file, release_ref PRE_TASK_075_RELEASE_REF, and for a
 * contract its contract_after; then the NOT NULLs and CHECKs of a fresh
 * ledger, under the same constraint names.
 */
async function upgradeLedger(sql: Reserved, l: LedgerName, rows: readonly { filename: string; phase: PhaseInfo }[]): Promise<void> {
  await sql.unsafe(`ALTER TABLE ${l.quoted} ADD COLUMN IF NOT EXISTS phase text, ADD COLUMN IF NOT EXISTS release_ref text, ADD COLUMN IF NOT EXISTS contract_after text`)
  const files = rows.map((r) => r.filename)
  const phases = rows.map((r) => r.phase.phase)
  const afters = rows.map((r) => (r.phase.phase === 'contract' ? (r.phase.contractAfter ?? '') : ''))
  await sql.unsafe(
    `UPDATE ${l.quoted} m
       SET phase = coalesce(m.phase, u.phase),
           release_ref = coalesce(m.release_ref, $1::text),
           contract_after = CASE WHEN coalesce(m.phase, u.phase) = 'contract' THEN coalesce(m.contract_after, nullif(u.contract_after, '')) END
      FROM unnest($2::text[], $3::text[], $4::text[]) AS u(filename, phase, contract_after)
     WHERE m.filename = u.filename`,
    [PRE_TASK_075_RELEASE_REF, files, phases, afters] as never,
  )
  await sql.unsafe(`ALTER TABLE ${l.quoted}
    ALTER COLUMN phase SET NOT NULL,
    ALTER COLUMN release_ref SET NOT NULL,
    DROP CONSTRAINT IF EXISTS ${l.table}_phase_check,
    ADD CONSTRAINT ${l.table}_phase_check CHECK (phase IN ('expand', 'migrate', 'contract')),
    DROP CONSTRAINT IF EXISTS ${l.table}_release_ref_check,
    ADD CONSTRAINT ${l.table}_release_ref_check CHECK (char_length(release_ref) BETWEEN 1 AND 64),
    DROP CONSTRAINT IF EXISTS ${l.table}_contract_after_check,
    ADD CONSTRAINT ${l.table}_contract_after_check CHECK ((phase = 'contract') = (contract_after IS NOT NULL))`)
}

/**
 * Q3: a session advisory lock does not survive PgBouncer transaction pooling,
 * so the runner refuses anything but a direct connection. A heuristic, with
 * two signals (and the per-file lock re-check behind it):
 *
 *  1. the backend pid the server announced in the protocol (BackendKeyData,
 *     which postgres-js keeps as `result.state.pid`) must equal
 *     pg_backend_pid(). A pooler answers the handshake itself, with its own
 *     cancel key, so the two differ — measured on PgBouncer 1.25.2 in
 *     transaction mode (and a TCP proxy that is not a pooler passes);
 *  2. `SHOW pool_mode` must be unknown (42704). The brief's Q3 signal, kept,
 *     but NOT sufficient on its own: PgBouncer forwards it to the server on
 *     an ordinary connection and Postgres answers 42704 (measured).
 * Any other error is not a verdict and is rethrown.
 */
export async function assertNotPooler(sql: Reserved | Sql): Promise<void> {
  const res = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
  const announced = (res as unknown as { state?: { pid?: number | null } }).state?.pid
  const actual = res[0]?.pid
  if (typeof announced !== 'number' || announced !== actual) {
    throw new MigrationRunnerError(
      'POOLER_TARGET',
      `the migration target is not a direct Postgres connection: the protocol announced backend ${announced} but the server runs ${actual} — a pooler sits in between, and a session advisory lock does not survive transaction pooling; connect the runner directly to Postgres`,
    )
  }
  let answered: unknown
  try {
    answered = await sql.unsafe('SHOW pool_mode')
  } catch (err) {
    if ((err as { code?: string }).code === '42704') return
    throw err
  }
  throw new MigrationRunnerError(
    'POOLER_TARGET',
    `the migration target answers SHOW pool_mode (${JSON.stringify(answered)}): it is a pooler — connect the runner directly to Postgres`,
  )
}

interface LedgerRow {
  filename: string
  sha256: string
}

/** The ledger's rows; `legacy` when it lacks a TASK-075 column (upgraded with the first pending file). */
async function readLedger(sql: Reserved, l: LedgerName): Promise<{ rows: LedgerRow[]; legacy: boolean } | null> {
  // to_regclass answers NULL for a missing table AND for a missing schema.
  const [reg] = await sql<{ present: boolean }[]>`SELECT pg_catalog.to_regclass(${l.text}) IS NOT NULL AS present`
  if (!reg?.present) return null
  let rows: LedgerRow[]
  try {
    rows = await sql.unsafe<LedgerRow[]>(`SELECT filename, sha256 FROM ${l.quoted} ORDER BY filename`)
  } catch (err) {
    throw new MigrationRunnerError('LEDGER_FORMAT', `${l.text} exists but cannot be read as (filename, sha256): ${(err as Error).message}`, [], { cause: err })
  }
  const cols = await sql<{ attname: string }[]>`
    SELECT attname FROM pg_catalog.pg_attribute
     WHERE attrelid = ${l.text}::regclass AND attnum > 0 AND NOT attisdropped AND attname = ANY(${[...LEDGER_COLUMNS]}::text[])`
  const legacy = LEDGER_COLUMNS.some((c) => !cols.some((r) => r.attname === c))
  return { rows, legacy }
}

/** True when `s` holds a C0 control character (U+0000-U+001F). */
export function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 0x20) return true
  return false
}

function assertReleaseRef(ref: unknown): asserts ref is string {
  if (typeof ref !== 'string' || ref.length < 1 || ref.length > 64 || hasControlChar(ref)) {
    throw new TypeError('runMigrations needs releaseRef: the release this run ships, 1-64 printable characters (ledger release_ref)')
  }
}

const MAX_LOCK_TIMEOUT_MS = 2 ** 31 - 1

function assertTimeout(name: string, ms: number | undefined): void {
  if (ms !== undefined && (!Number.isInteger(ms) || ms < 0 || ms > MAX_LOCK_TIMEOUT_MS)) {
    throw new RangeError(`${name} must be an integer number of milliseconds (0 = no limit)`)
  }
}

export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const { sql, hooks = {}, log = (l) => console.info(`[tenant-store] ${l}`) } = options
  if ((options.dir === undefined) === (options.dirs === undefined)) {
    throw new TypeError('runMigrations needs exactly one of dir (one migrations directory) or dirs (a chain spanning several)')
  }
  const dirs: readonly string[] = options.dirs ?? [options.dir!]
  if (!Array.isArray(dirs) || dirs.length === 0) throw new TypeError('runMigrations: dirs must be a non-empty array')
  const dir = dirs[0]!
  const ledger = ledgerName(options.ledger ?? LEDGER)
  assertReleaseRef(options.releaseRef)
  const releaseRef = options.releaseRef
  const lockWaitTimeoutMs = options.lockWaitTimeoutMs ?? 10 * 60_000
  const ddlLockTimeoutMs = options.ddlLockTimeoutMs
  assertTimeout('lockWaitTimeoutMs', lockWaitTimeoutMs)
  assertTimeout('ddlLockTimeoutMs', ddlLockTimeoutMs)
  const { classid, objid } = ADVISORY_LOCKS.migration
  // The runner reserves one connection and, if it can never release its
  // lock, terminates that backend over ANOTHER one: with max 1 that second
  // query would wait forever for the reserved connection.
  const poolMax = (sql as { options?: { max?: number } }).options?.max
  if (typeof poolMax !== 'number' || poolMax < 2) {
    throw new RangeError(`runMigrations needs a pool of at least 2 connections (got max ${poolMax}); openMigrationDb opens one`)
  }
  const reserved = await sql.reserve()
  let locked = false
  let pid = -1
  // Set when the reserved connection may still hold the lock or an open
  // transaction: it is then terminated, never handed back to the pool.
  let poisoned: unknown
  let failure: unknown
  // preApply or a body may have set session state; reset before release.
  let sessionTouched = false

  const lockHeld = async () => {
    // pg_catalog-qualified: a body's search_path must not be able to fake it.
    const [held] = await reserved<{ ok: boolean }[]>`
      SELECT pg_catalog.pg_backend_pid() = ${pid} AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_locks
         WHERE locktype = 'advisory' AND pid = ${pid} AND granted
           AND classid = ${classid}::oid AND objid = ${objid}::oid AND objsubid = 2
           AND database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
      ) AS ok`
    return held?.ok === true
  }

  try {
    await assertNotPooler(reserved)
    const [me] = await reserved<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
    pid = me!.pid

    const [first] = await reserved<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(${classid}::int4, ${objid}::int4) AS ok`
    if (!first?.ok) {
      const holders = await reserved<{ pid: number; app: string | null }[]>`
        SELECT l.pid, a.application_name AS app
          FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE l.locktype = 'advisory' AND l.granted
           AND l.classid = ${classid}::oid AND l.objid = ${objid}::oid AND l.objsubid = 2
           AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`
      log(
        `waiting for the migration lock (held by ${holders.map((h) => `pid ${h.pid}${h.app ? ` '${h.app}'` : ''}`).join(', ') || 'another session'}); giving up after ${lockWaitTimeoutMs === 0 ? 'no limit' : `${lockWaitTimeoutMs} ms`}`,
      )
      // lock_timeout bounds the advisory-lock wait too; the wait stays a
      // real pg_locks waiter (not a try-lock loop), so it is observable.
      // statement_timeout off for the wait, so a shorter role default does
      // not surface as a raw 57014 instead of LOCK_TIMEOUT.
      await reserved`SELECT set_config('lock_timeout', ${String(lockWaitTimeoutMs)}, false), set_config('statement_timeout', '0', false)`
      let waitErr: unknown
      try {
        await reserved`SELECT pg_advisory_lock(${classid}::int4, ${objid}::int4)`
      } catch (err) {
        waitErr = err
      }
      try {
        await reserved.unsafe('RESET lock_timeout; RESET statement_timeout')
      } catch (resetErr) {
        // never mask the wait's own error; a failed reset poisons the connection
        poisoned = resetErr
        if (waitErr === undefined) throw resetErr
      }
      if (waitErr !== undefined) {
        if ((waitErr as { code?: string }).code === '55P03') {
          throw new MigrationRunnerError('LOCK_TIMEOUT', `the migration lock was not granted within ${lockWaitTimeoutMs} ms`, [], { cause: waitErr })
        }
        throw waitErr
      }
    }
    locked = true

    // Everything below this line and above the first BEGIN is read-only.
    const migrations = readVerifiedUnion(dirs)
    const read = await readLedger(reserved, ledger)
    const rowsInLedger = read?.rows ?? null
    const bySha = new Map(migrations.map((m) => [m.file, m.sha256]))
    const unknown = (rowsInLedger ?? []).filter((r) => !bySha.has(r.filename)).map((r) => r.filename)
    if (unknown.length) {
      throw new MigrationRunnerError('LEDGER_UNKNOWN_FILE', `applied migrations have no file in ${dirs.join(', ')}: ${unknown.join(', ')}`, unknown)
    }
    const changed = (rowsInLedger ?? []).filter((r) => bySha.get(r.filename) !== r.sha256).map((r) => r.filename)
    if (changed.length) {
      throw new MigrationRunnerError(
        'LEDGER_HASH_MISMATCH',
        `applied migrations no longer match the sha256 the ledger recorded: ${changed.join(', ')}`,
        changed,
      )
    }
    const applied = new Set((rowsInLedger ?? []).map((r) => r.filename))
    const pending = migrations.filter((m) => !applied.has(m.file))
    // Number order (a union of dirs is one sequence); for one dir with a fixed
    // pad width this is the filename order the runner always used.
    const highest = [...applied].sort(compareMigrationFiles).at(-1)
    const below = highest === undefined ? [] : pending.filter((m) => compareMigrationFiles(m.file, highest) < 0).map((m) => m.file)
    if (below.length) {
      throw new MigrationRunnerError(
        'OUT_OF_ORDER',
        `pending migrations sort below the highest applied one (${highest}); a back-fill is refused, number the change after it: ${below.join(', ')}`,
        below,
      )
    }
    // TASK-075: every pending file's phase, before any hook, dump or DDL.
    const phases = new Map<string, PhaseInfo>()
    for (const m of pending) {
      try {
        phases.set(m.file, resolvePhase(m.file, m.text, options.phaseFor))
      } catch (err) {
        if (err instanceof PhaseError) throw new MigrationRunnerError(err.code, `${err.message}; nothing was applied`, [m.file], { cause: err })
        throw err
      }
    }
    const bodies = pending.map((m) => ({ ...m, body: stripOuterTransaction(m.text), phase: phases.get(m.file)! }))
    if (bodies.length === 0) return { applied: [], alreadyApplied: applied.size }
    // TASK-075 r2: a pre-TASK-075 ledger is upgraded with the first file
    // (upgradeLedger); every applied row's phase is resolved here, read-only,
    // so an applied file with none refuses the run before any hook or DDL.
    let upgrade: { filename: string; phase: PhaseInfo }[] | null = null
    if (read?.legacy) {
      const text = new Map(migrations.map((m) => [m.file, m.text]))
      upgrade = []
      for (const r of rowsInLedger ?? []) {
        try {
          upgrade.push({ filename: r.filename, phase: resolvePhase(r.filename, text.get(r.filename)!, options.phaseFor) })
        } catch (err) {
          if (err instanceof PhaseError) {
            throw new MigrationRunnerError(err.code, `${err.message}: ${ledger.text} predates TASK-075 and its applied row ${r.filename} needs a phase for the ledger upgrade; nothing was applied`, [r.filename], { cause: err })
          }
          throw err
        }
      }
    }

    const ctx: PreApplyContext = {
      sql: reserved,
      dir,
      dirs,
      ledger: ledger.text,
      applied: [...applied].sort(compareMigrationFiles),
      pending: bodies.map((m) => m.file),
    }
    let ledgerPresent = rowsInLedger !== null
    const done: string[] = []
    for (const m of bodies) {
      sessionTouched = true
      try {
        await hooks.preApply?.(m.file, ctx)
      } catch (err) {
        throw new MigrationRunnerError('PRE_APPLY_FAILED', `preApply refused ${m.file}; it and every later file were not applied (earlier files of this run stay applied)`, [m.file], { cause: err })
      }
      // Defence in depth for Q3: the lock must still be ours, on this backend.
      if (!(await lockHeld())) throw new MigrationRunnerError('LOCK_NOT_HELD', `the migration lock is not held by this connection before ${m.file}`, [m.file])

      await reserved.unsafe('BEGIN')
      try {
        const [before] = await reserved<{ xid: string }[]>`SELECT pg_current_xact_id()::text AS xid`
        if (ddlLockTimeoutMs !== undefined) {
          await reserved`SELECT set_config('lock_timeout', ${String(ddlLockTimeoutMs)}, true)`
        }
        if (!ledgerPresent) {
          // TASK-077 G3(a): a ledger in its own schema (idt.schema_migration)
          // needs that schema before the table. Only issued when the schema is
          // absent: CREATE SCHEMA checks CREATE on the database before IF NOT
          // EXISTS, and a runner that never needed it (public) must not start to.
          const [ns] = await reserved<{ present: boolean }[]>`SELECT pg_catalog.to_regnamespace(${ledger.schema}) IS NOT NULL AS present`
          if (!ns?.present) await reserved.unsafe(`CREATE SCHEMA IF NOT EXISTS "${ledger.schema}"`)
          await reserved.unsafe(ledgerDdl(ledger))
        } else if (upgrade !== null) await upgradeLedger(reserved, ledger, upgrade)
        await reserved.unsafe(m.body)
        // A COMMIT that slipped past stripOuterTransaction would leave the
        // rest of the body, and the ledger row, outside this transaction.
        const [after] = await reserved<{ xid: string | null }[]>`SELECT pg_current_xact_id_if_assigned()::text AS xid`
        if (after?.xid !== before?.xid) {
          throw new MigrationRunnerError('TRANSACTION_ESCAPED', `${m.file} ended the runner's transaction; its statements before that point are committed without a ledger row`, [m.file])
        }
        // The ledger row is written as the runner's own identity, whatever
        // role the body switched to.
        await reserved.unsafe('RESET ROLE; RESET SESSION AUTHORIZATION')
        // ... and a body that released the lock must not commit (e.g. pg_advisory_unlock_all()).
        if (!(await lockHeld())) throw new MigrationRunnerError('LOCK_NOT_HELD', `${m.file} released the migration lock; rolled back`, [m.file])
        await reserved.unsafe(
          `INSERT INTO ${ledger.quoted} (filename, sha256, phase, release_ref, contract_after) VALUES ($1, $2, $3, $4, $5)`,
          [m.file, m.sha256, m.phase.phase, releaseRef, m.phase.phase === 'contract' ? (m.phase.contractAfter ?? null) : null],
        )
        await reserved.unsafe('COMMIT')
      } catch (err) {
        try {
          await reserved.unsafe('ROLLBACK')
        } catch (rollbackErr) {
          poisoned = rollbackErr
        }
        if (err instanceof MigrationRunnerError) throw err
        throw new MigrationRunnerError('APPLY_FAILED', `${m.file} failed and was rolled back: ${(err as Error).message}`, [m.file], { cause: err })
      }
      // Session state a body set (SET ROLE, search_path, statement_timeout,
      // ...) survives COMMIT: reset it, so the next file — and the caller's
      // pool this connection goes back to — start from the defaults.
      await reserved.unsafe('RESET ALL; RESET ROLE; RESET SESSION AUTHORIZATION')
      if (upgrade !== null) log(`upgraded ${ledger.text} to the TASK-075 columns: ${upgrade.length} applied row(s) backfilled, release_ref ${PRE_TASK_075_RELEASE_REF}`)
      upgrade = null
      ledgerPresent = true
      done.push(m.file)
      log(`applied ${m.file}`)
    }
    return { applied: done, alreadyApplied: applied.size }
  } catch (err) {
    failure = err
    throw err
  } finally {
    try {
      if (sessionTouched && poisoned === undefined) {
        try {
          await reserved.unsafe('RESET ALL; RESET ROLE; RESET SESSION AUTHORIZATION')
        } catch (resetErr) {
          poisoned = resetErr
        }
      }
      if (locked && poisoned === undefined) {
        // No throw inside this finally (T5, no-unsafe-finally): a failed unlock
        // only marks the connection poisoned; the block below decides whether
        // it surfaces (UNLOCK_FAILED on an otherwise clean run) or is logged
        // beside the run's own error, which always propagates unchanged.
        try {
          const [r] = await reserved<{ ok: boolean }[]>`SELECT pg_advisory_unlock(${classid}::int4, ${objid}::int4) AS ok`
          if (!r?.ok) poisoned = new Error('pg_advisory_unlock returned false')
        } catch (unlockErr) {
          poisoned = unlockErr
        }
      }
      if (poisoned !== undefined && pid > 0) {
        // The connection may still hold the lock (or an aborted transaction).
        // Terminate its backend from another connection instead of handing it
        // back to the pool: its session lock dies with it.
        let timer: ReturnType<typeof setTimeout> | undefined
        const killed = await Promise.race([
          sql<{ ok: boolean }[]>`SELECT pg_terminate_backend(${pid}) AS ok`.then(
            (r) => r[0]?.ok === true,
            () => false,
          ),
          new Promise<false>((r) => (timer = setTimeout(() => r(false), 10_000))),
        ])
        clearTimeout(timer)
        const cause = failure instanceof MigrationRunnerError && failure.code === 'LOCK_NOT_HELD' ? ' after the lock was already lost' : ''
        const msg = `the connection could not be returned clean${cause} (${(poisoned as Error).message}); backend ${pid} ${killed ? 'was terminated' : 'could NOT be terminated — the lock may stay held until that connection closes'}`
        if (failure === undefined) {
          // eslint-disable-next-line no-unsafe-finally
          throw new MigrationRunnerError('UNLOCK_FAILED', msg, [], { cause: poisoned })
        }
        log(msg)
      }
    } finally {
      reserved.release()
    }
  }
}
