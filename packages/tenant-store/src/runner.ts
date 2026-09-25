// packages/tenant-store/src/runner.ts
//
// The one migration runner (DL-001) for one (tenant, module) database. It
// replaces the leaf ledgers, and gremion-ui's db.ts / control-migrations.ts
// runners when those adopt it (TASK-077/084); there is no boot migration.
//
// Order of a run, and why:
//   1. reserve ONE connection (sql.reserve()); every step below runs on it.
//   2. refuse a pooler (Q3): a session advisory lock does not survive
//      PgBouncer transaction pooling.
//   3. pg_advisory_lock(ADVISORY_LOCKS.migration) — BEFORE schema_migrations
//      is read. Read-then-lock lets two runners both see the same pending
//      set; the second waits here instead, then reads a ledger that already
//      has everything.
//   4. verify the WHOLE manifest (every file, both directions, every sha256)
//      and prepare every pending body (stripOuterTransaction) — pure, no DDL.
//   5. read the ledger WITHOUT DDL (to_regclass) and check it against the
//      manifest: an applied file whose bytes no longer match the sha256 the
//      ledger recorded, or a ledger row with no file, aborts here — tamper
//      after apply is caught before any DDL too.
//   6. refuse a pending file that sorts below the highest applied one (Q4).
//   7. per pending file: hooks.preApply (under the lock, before the file's
//      transaction), then ONE transaction holding the file's body and its
//      ledger row (G-078). The ledger table itself is created inside the first
//      file's transaction, so a run that applies nothing executes no DDL.
//   8. finally: pg_advisory_unlock, then release the connection.
import type { Sql } from '@gremion/db'
import type postgres from 'postgres'
import { ADVISORY_LOCKS } from './advisory-locks.js'
import { readVerifiedMigrations, MIGRATION_FILENAME } from './manifest.js'
import { stripOuterTransaction } from './strip-outer-transaction.js'

type Reserved = postgres.ReservedSql<{}>

export interface PreApplyContext {
  /** The reserved, lock-holding connection. Not inside a transaction. */
  sql: Reserved
  dir: string
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
  /** The module's migrations directory, holding manifest.json. */
  dir: string
  hooks?: RunMigrationsHooks
  log?: (line: string) => void
}

export interface RunMigrationsResult {
  applied: string[]
  alreadyApplied: number
}

export class MigrationRunnerError extends Error {
  override name = 'MigrationRunnerError'
  constructor(
    readonly code:
      | 'POOLER_TARGET'
      | 'LOCK_NOT_HELD'
      | 'LEDGER_FORMAT'
      | 'LEDGER_UNKNOWN_FILE'
      | 'LEDGER_HASH_MISMATCH'
      | 'OUT_OF_ORDER'
      | 'PRE_APPLY_FAILED'
      | 'APPLY_FAILED'
      | 'TRANSACTION_ESCAPED'
      | 'UNLOCK_FAILED',
    message: string,
    readonly files: readonly string[] = [],
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

export const LEDGER = 'public.schema_migrations'

const LEDGER_DDL = `CREATE TABLE ${LEDGER} (
  filename   text PRIMARY KEY CHECK (filename ~ '${MIGRATION_FILENAME.source.replaceAll("'", "''")}'),
  sha256     text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
)`

/**
 * Q3: PgBouncer answers `SHOW pool_mode`; Postgres does not know the
 * parameter (42704). Anything else is not a verdict, so it is rethrown.
 */
export async function assertNotPooler(sql: Pick<Sql, 'unsafe'>): Promise<void> {
  let answered: unknown
  try {
    answered = await sql.unsafe('SHOW pool_mode')
  } catch (err) {
    if ((err as { code?: string }).code === '42704') return
    throw err
  }
  throw new MigrationRunnerError(
    'POOLER_TARGET',
    `the migration target answers SHOW pool_mode (${JSON.stringify(answered)}): it is a pooler, and a session advisory lock does not survive transaction pooling — connect the runner directly to Postgres`,
  )
}

interface LedgerRow {
  filename: string
  sha256: string
}

async function readLedger(sql: Reserved): Promise<LedgerRow[] | null> {
  const [reg] = await sql<{ present: boolean }[]>`SELECT to_regclass(${LEDGER}) IS NOT NULL AS present`
  if (!reg?.present) return null
  try {
    return await sql<LedgerRow[]>`SELECT filename, sha256 FROM public.schema_migrations ORDER BY filename`
  } catch (err) {
    throw new MigrationRunnerError('LEDGER_FORMAT', `${LEDGER} exists but cannot be read as (filename, sha256): ${(err as Error).message}`, [], { cause: err })
  }
}

export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const { sql, dir, hooks = {}, log = (l) => console.info(`[tenant-store] ${l}`) } = options
  const { classid, objid } = ADVISORY_LOCKS.migration
  const reserved = await sql.reserve()
  let locked = false
  let failure: unknown
  try {
    await assertNotPooler(reserved)

    await reserved`SELECT pg_advisory_lock(${classid}::int4, ${objid}::int4)`
    locked = true
    const [{ pid } = { pid: -1 }] = await reserved<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`

    // Everything below this line and above the first BEGIN is read-only.
    const migrations = readVerifiedMigrations(dir)
    const ledger = await readLedger(reserved)
    const bySha = new Map(migrations.map((m) => [m.file, m.sha256]))
    const unknown = (ledger ?? []).filter((r) => !bySha.has(r.filename)).map((r) => r.filename)
    if (unknown.length) {
      throw new MigrationRunnerError('LEDGER_UNKNOWN_FILE', `applied migrations have no file in ${dir}: ${unknown.join(', ')}`, unknown)
    }
    const changed = (ledger ?? []).filter((r) => bySha.get(r.filename) !== r.sha256).map((r) => r.filename)
    if (changed.length) {
      throw new MigrationRunnerError(
        'LEDGER_HASH_MISMATCH',
        `applied migrations no longer match the sha256 the ledger recorded: ${changed.join(', ')}`,
        changed,
      )
    }
    const applied = new Set((ledger ?? []).map((r) => r.filename))
    const pending = migrations.filter((m) => !applied.has(m.file))
    const highest = [...applied].sort().at(-1)
    const below = highest === undefined ? [] : pending.filter((m) => m.file < highest).map((m) => m.file)
    if (below.length) {
      throw new MigrationRunnerError(
        'OUT_OF_ORDER',
        `pending migrations sort below the highest applied one (${highest}); a back-fill is refused, number the change after it: ${below.join(', ')}`,
        below,
      )
    }
    const bodies = pending.map((m) => ({ ...m, body: stripOuterTransaction(m.text) }))
    if (bodies.length === 0) return { applied: [], alreadyApplied: applied.size }

    const ctx: PreApplyContext = {
      sql: reserved,
      dir,
      applied: [...applied].sort(),
      pending: bodies.map((m) => m.file),
    }
    let ledgerPresent = ledger !== null
    const done: string[] = []
    for (const m of bodies) {
      try {
        await hooks.preApply?.(m.file, ctx)
      } catch (err) {
        throw new MigrationRunnerError('PRE_APPLY_FAILED', `preApply refused ${m.file}; it and every later file were not applied`, [m.file], { cause: err })
      }
      // Defence in depth for Q3: the lock must still be ours, on this backend.
      const [held] = await reserved<{ ok: boolean }[]>`
        SELECT pg_backend_pid() = ${pid} AND EXISTS (
          SELECT 1 FROM pg_locks
           WHERE locktype = 'advisory' AND pid = ${pid} AND granted
             AND classid = ${classid}::oid AND objid = ${objid}::oid AND objsubid = 2
             AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        ) AS ok`
      if (!held?.ok) throw new MigrationRunnerError('LOCK_NOT_HELD', `the migration lock is not held by this connection before ${m.file}`, [m.file])

      await reserved.unsafe('BEGIN')
      try {
        const [before] = await reserved<{ xid: string }[]>`SELECT pg_current_xact_id()::text AS xid`
        if (!ledgerPresent) await reserved.unsafe(LEDGER_DDL)
        await reserved.unsafe(m.body)
        // A COMMIT that slipped past stripOuterTransaction would leave the
        // rest of the body, and the ledger row, outside this transaction.
        const [after] = await reserved<{ xid: string | null }[]>`SELECT pg_current_xact_id_if_assigned()::text AS xid`
        if (after?.xid !== before?.xid) {
          throw new MigrationRunnerError('TRANSACTION_ESCAPED', `${m.file} ended the runner's transaction; its statements before that point are committed without a ledger row`, [m.file])
        }
        await reserved`INSERT INTO public.schema_migrations (filename, sha256) VALUES (${m.file}, ${m.sha256})`
        await reserved.unsafe('COMMIT')
      } catch (err) {
        await reserved.unsafe('ROLLBACK').catch(() => {})
        if (err instanceof MigrationRunnerError) throw err
        throw new MigrationRunnerError('APPLY_FAILED', `${m.file} failed and was rolled back: ${(err as Error).message}`, [m.file], { cause: err })
      }
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
      if (locked) {
        const [r] = await reserved<{ ok: boolean }[]>`SELECT pg_advisory_unlock(${classid}::int4, ${objid}::int4) AS ok`
        if (!r?.ok) throw new Error('pg_advisory_unlock returned false')
      }
    } catch (unlockErr) {
      // Last resort: drop every session lock this backend holds. If even that
      // fails the connection is gone, and its session locks went with it.
      await reserved`SELECT pg_advisory_unlock_all()`.catch(() => {})
      if (failure === undefined) {
        // eslint-disable-next-line no-unsafe-finally
        throw new MigrationRunnerError('UNLOCK_FAILED', `releasing the migration lock failed: ${(unlockErr as Error).message}`, [], { cause: unlockErr })
      }
      log(`releasing the migration lock failed after an earlier error: ${(unlockErr as Error).message}`)
    } finally {
      reserved.release()
    }
  }
}
