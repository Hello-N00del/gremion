// services/kernel-api/src/migrate/migrate.ts — Q10: `kernel-api migrate`.
//
// The kernel API never migrates on a request or at boot (B21); this is the
// one place its chain is applied, per customer:
//
//   migrateKernelDb(customerId, o)   one customer (exported: the provisioning
//                                    engine's post-create step calls the CLI
//                                    form, lane note C2 / hand-off to 043d);
//   migrateAllCustomers(o)           the deploy one-shot (kernel-api-migrate):
//                                    every `active` / `suspended` customer,
//                                    the others skipped and logged; it goes on
//                                    past a failure and reports every one.
//
// Per customer (Q3, lane note C10):
//   1. its control row (customer-scoped read) -> db_conn_ref -> the secret;
//   2. the SAME credentials on the DIRECT server (directUrlFor), asserted to
//      name t_<hex32>__kernel; the runner refuses a pooler (assertNotPooler)
//      and takes its session advisory lock;
//   3. current_database() re-asserted on the connection;
//   4. runMigrations over the union of the chain's dirs into
//      idt.schema_migration (G3), preApply = TASK-029's chainPreApply, then
//      TASK-075's dump hook (ONE `created` line before the first BEGIN, scope
//      customer), then SET ROLE k_<hex32>_owner -- in that order (C10), so a
//      chain-refused run takes no dump and every object is the owner's;
//   5. verified after apply: the gate's own check says current (or ahead).
import type { Sql } from '@gremion/db'
import { checkSchemaCurrent, runMigrations } from '@gremion/tenant-store'
import { composePreApply, dumpTools, migratePreApply, type DumpFs } from '@gremion/tenant-store/dump'
import type { Exporter } from '@gremion/tenant-store/lifecycle'
import postgres from 'postgres'
import { chainFileNames } from '../../../../scripts/migrations/pre-apply.mjs'
import { directUrlFor, kernelDatabaseOf } from '../tenancy/target.ts'
import { KERNEL_API_CHAIN, KERNEL_API_LEDGER } from './chain.ts'
import { afterKernelRun, beforeKernelRun } from './idt-hooks.ts'
import { withMigrationLock } from './lock.ts'

export type MigrateErrorCode = 'INVALID_CUSTOMER' | 'UNKNOWN_CUSTOMER' | 'STATUS_SKIPPED' | 'WRONG_DATABASE' | 'NOT_CURRENT_AFTER_APPLY'

export class MigrateError extends Error {
  override name = 'MigrateError'
  constructor(
    readonly code: MigrateErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${code}: ${message}`, options)
  }
}

/** Statuses the deploy one-shot migrates; everything else is skipped (logged). */
export const MIGRATED_STATUSES: ReadonlySet<string> = new Set(['active', 'suspended'])
/**
 * An explicit `--customer` also takes a customer still `provisioning` [A]:
 * the provisioning engine runs it after the kernel-data migration and BEFORE
 * the customer is marked active (hand-off to TASK-043d). deleting / deleted
 * are never migrated.
 */
export const MIGRATED_STATUSES_EXPLICIT: ReadonlySet<string> = new Set(['provisioning', 'active', 'suspended'])

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const OWNER_ROLE = /^k_[0-9a-f]{32}_owner$/

/** Bounded defaults: a blocked customer fails fast and the job continues (KERNEL_API_MIGRATE_LOCK_WAIT_MS / _DDL_LOCK_TIMEOUT_MS). */
export const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 60_000
export const DEFAULT_DDL_LOCK_TIMEOUT_MS = 5_000

export interface MigrateOptions {
  /** The control registry (the reader role suffices: two SELECTs). */
  control: Sql
  resolveSecret(ref: string): string
  /** GREMION_KERNEL_PG_DIRECT_URL: the kernel Postgres server itself (host, port), never PgBouncer. */
  directBase: string
  /** Absolute migration dirs of the kernel-api chain (the service root's KERNEL_API_MIGRATION_DIRS). */
  dirs: readonly string[]
  /** Where scripts/migrations/ranges.json lives (TASK-029's chain file set). */
  kernelRoot: string
  /** GREMION_RELEASE_REF: ledger release_ref and the dump's release. */
  releaseRef: string
  /** GREMION_MIGRATION_DUMP_DIR (0700, this uid). */
  dumpDir: string | undefined
  /**
   * How long one customer may wait for the migration advisory lock (another migrate
   * session on the same database) before it FAILS and the job moves on to the next
   * customer. Default 60 s (the runner's own default is 10 min per customer).
   */
  lockWaitTimeoutMs?: number
  /** lock_timeout of every migration transaction's DDL (a stuck ACCESS EXCLUSIVE queue fails fast). Default 5 s. */
  ddlLockTimeoutMs?: number
  log(line: string): void
  /** One stdout line per dump event (TRD-143). */
  audit(line: string): void
  /** Test seams. */
  tools?: { exporter: Exporter; pgDumpMajor(): Promise<number> }
  pgDumpContainer?: string
  dumpFs?: DumpFs
  openSql?: (url: string) => Sql
}

export interface CustomerResult {
  customerId: string
  applied: string[]
  alreadyApplied: number
}

interface ControlRow {
  id: string
  slug: string
  status: string
  db_conn_ref: string
}

/** The preApply that makes every object the owner's (C10: after the chain check and the dump). */
export function setRoleHook(owner: string) {
  if (!OWNER_ROLE.test(owner)) throw new MigrateError('INVALID_CUSTOMER', `refusing owner role ${JSON.stringify(owner)}`)
  return async (_file: string, ctx: { sql: Sql | postgres.ReservedSql<{}> }) => {
    await ctx.sql.unsafe(`SET ROLE "${owner}"`)
    const [me] = await ctx.sql<{ who: string }[]>`SELECT current_user AS who`
    if (me?.who !== owner) throw new MigrateError('WRONG_DATABASE', `SET ROLE ${owner} did not take (current_user ${String(me?.who)})`)
  }
}

export async function migrateKernelDb(customerId: string, o: MigrateOptions & { statuses?: ReadonlySet<string> }): Promise<CustomerResult> {
  if (typeof customerId !== 'string' || !UUID_V7.test(customerId)) throw new MigrateError('INVALID_CUSTOMER', `${JSON.stringify(customerId)} is not a customer id (canonical UUIDv7)`)
  const rows = await o.control<ControlRow[]>`
    SELECT t.id::text AS id, t.slug, t.status, t.db_conn_ref FROM public.tenant t WHERE t.id = ${customerId}::uuid`
  const row = rows[0]
  if (!row) throw new MigrateError('UNKNOWN_CUSTOMER', `no customer ${customerId} in the control registry`)
  const statuses = o.statuses ?? MIGRATED_STATUSES_EXPLICIT
  if (!statuses.has(row.status)) throw new MigrateError('STATUS_SKIPPED', `customer ${customerId} is ${row.status}: not migrated`)

  const database = kernelDatabaseOf(customerId)
  const url = directUrlFor(o.resolveSecret(row.db_conn_ref), o.directBase, customerId)
  const sql = (o.openSql ?? ((u: string) => postgres(u, { max: 2, prepare: true, onnotice: () => {}, connect_timeout: 15 })))(url)
  try {
    const [who] = await sql<{ db: string }[]>`SELECT pg_catalog.current_database() AS db`
    if (who?.db !== database) throw new MigrateError('WRONG_DATABASE', `the migration connection is on ${JSON.stringify(who?.db)}, not ${database}`)
    // tenant-store lifecycle kernelRoles(customerId).owner, restated (the
    // lifecycle subpath drags the module catalogue into the image).
    const owner = `k_${customerId.replaceAll('-', '')}_owner`
    const tools = o.tools ?? dumpTools(new URL(url), o.pgDumpContainer)
    const log = (l: string) => o.log(`[kernel-api migrate ${customerId}] ${l}`)
    const hookTarget = { customerId, owner, lockTimeoutMs: o.ddlLockTimeoutMs ?? DEFAULT_DDL_LOCK_TIMEOUT_MS }
    // TASK-080-a brief G4: the schema and btree_gist exist before the first file (the gist EXCLUDEs need them).
    // It runs as a preApply step, i.e. UNDER the runner's migration lock and after the dump (a second concurrent
    // run waits for that lock, so two runs never race CREATE SCHEMA / CREATE EXTENSION IF NOT EXISTS). Idempotent;
    // once per run (the first file is the one that needs it).
    let beforeDone = false
    const beforeHook = async () => {
      if (beforeDone) return
      await beforeKernelRun(sql, hookTarget)
      beforeDone = true
    }
    const r = await runMigrations({
      sql,
      dirs: o.dirs,
      ledger: KERNEL_API_LEDGER,
      releaseRef: o.releaseRef,
      lockWaitTimeoutMs: o.lockWaitTimeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS,
      ddlLockTimeoutMs: o.ddlLockTimeoutMs ?? DEFAULT_DDL_LOCK_TIMEOUT_MS,
      // the runtime role reads/appends the ledger by an explicit grant, not owner membership (TASK-192)
      ledgerGrantTo: owner.replace(/_owner$/, '_app'),
      log,
      hooks: {
        preApply: composePreApply(
          migratePreApply({
            chainFiles: chainFileNames(KERNEL_API_CHAIN, { root: o.kernelRoot }),
            log,
            dump: {
              dir: o.dumpDir,
              release: o.releaseRef,
              exporter: tools.exporter,
              pgDumpMajor: () => tools.pgDumpMajor(),
              audit: (line) => o.audit(line),
              ...(o.dumpFs ? { fs: o.dumpFs } : {}),
            },
          }),
          setRoleHook(owner),
          beforeHook,
        ),
      },
    })
    // ... and the binding, the customer setting and the vendor kinds exist after the last (all idempotent, all under the GUC).
    // The runner has released its lock by now and has no post hook: take the same lock for this step.
    const after = await withMigrationLock(sql, { timeoutMs: o.lockWaitTimeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS }, () => afterKernelRun(sql, hookTarget))
    if (after.bindingCreated || after.customerSettingCreated || after.kindsCreated > 0) {
      log(`idt seeded: binding ${after.bindingCreated ? 'created' : 'present'}, customer_setting ${after.customerSettingCreated ? 'created' : 'present'}, ${after.kindsCreated} kind(s) added`)
    }
    const status = await checkSchemaCurrent({ sql, dirs: o.dirs, ledger: KERNEL_API_LEDGER, releaseRef: o.releaseRef })
    if (status.state !== 'current' && status.state !== 'ahead') {
      throw new MigrateError('NOT_CURRENT_AFTER_APPLY', `customer ${customerId} is ${status.state} after the run (pending [${status.pending.join(', ')}], mismatched [${status.mismatched.join(', ')}])`)
    }
    return { customerId, applied: r.applied, alreadyApplied: r.alreadyApplied }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export interface AllResult {
  migrated: CustomerResult[]
  skipped: { customerId: string; status: string }[]
  failed: { customerId: string; error: string }[]
}

/**
 * The deploy one-shot. TRD-082 pinned exemption 3: this is the ONE query that
 * reads every customer (it must: it iterates them).
 */
export async function migrateAllCustomers(o: MigrateOptions): Promise<AllResult> {
  const rows = await o.control<{ id: string; status: string }[]>`SELECT t.id::text AS id, t.status FROM public.tenant t ORDER BY t.id`
  const out: AllResult = { migrated: [], skipped: [], failed: [] }
  for (const row of rows) {
    if (!MIGRATED_STATUSES.has(row.status)) {
      out.skipped.push({ customerId: row.id, status: row.status })
      o.log(`[kernel-api migrate] skipped ${row.id}: ${row.status}`)
      continue
    }
    try {
      out.migrated.push(await migrateKernelDb(row.id, { ...o, statuses: MIGRATED_STATUSES }))
    } catch (err) {
      const cause = (err as { cause?: { message?: string } }).cause?.message
      out.failed.push({ customerId: row.id, error: `${(err as Error).message}${cause ? ` (cause: ${cause})` : ''}` })
      o.log(`[kernel-api migrate] FAILED ${row.id}: ${(err as Error).message}`)
    }
  }
  return out
}
