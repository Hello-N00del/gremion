// packages/tenant-store/src/lifecycle/purge.ts
//
// TRD-144 / TRD-145 (TASK-033-a): the scheduled purge run. It removes rows past
// the window of their retention category and records the outcome in one
// plt.job_run row per run (platform migration 0012 gives the row its `detail`).
//
// WHICH categories: only those docs/compliance/retention-catalogue.md gives a
// CONCRETE window (a number of days) AND whose table is in this repository.
// PURGE_RULES is that list and nothing else; PURGE_RESIDUAL names every other
// category with a window-shaped row and why it is not purged here. Nothing is
// inferred: a rule cites its catalogue row, purge.test.ts re-reads the
// catalogue and the migrations and fails when a window or a column drifts.
//
// AS WHOM: a kernel-scope rule runs as the customer's k_<hex>_purger role
// (kernel.ts: NOLOGIN, outside the owner). The run connects as the kernel
// server's admin (the lifecycle's ModuleServer), grants the purger exactly
// SELECT + DELETE on the mapped table (idempotent), and deletes inside a
// transaction that does SET LOCAL ROLE <purger>: the DELETE itself carries only
// the purger's privileges, so a table with no rule (audit_log, the governance
// records) is out of reach of the run by privilege, not by the SQL text. The
// platform-scope rule (plt.job_run) runs as the platform connection's own role:
// gremion_platform has no purger role, and job_run's DELETE is open by design
// (0005: "a DELETE must stay possible for the retention purge").
//
// SAFE TO RE-RUN: every rule is "delete rows whose start event is older than
// now - window", so a second run deletes 0 and still writes its own job_run row.
// One run at a time (advisory lock on gremion_platform); a second concurrent run
// writes a `skipped` row and deletes nothing. A run with no enabled platform
// purge_run definition refuses before it deletes anything (a purge with no record
// is not run). A failure in one customer database or rule is recorded and the
// rest still run; the row's status is then `failed`.
import type { Sql } from '@gremion/db'
import { ADVISORY_LOCKS } from '../advisory-locks.js'
import { execFormatted } from './ddl.js'
import { kernelRoles } from './kernel.js'
import type { ModuleServer } from './types.js'

export interface PurgeRule {
  /** `<catalogue row>/<table>`: the key of this category in the job_run detail. */
  readonly id: string
  /** The retention-catalogue row that states the window (docs/compliance/retention-catalogue.md). */
  readonly catalogueRow: string
  /** Set when the row states its window by reference to another row (RC-OPS-RUN: "with RC-LOG-APP"). */
  readonly windowFrom?: string
  /** DB-OPS-RETENTION-PROFILE of the data, as the catalogue writes it. */
  readonly profile: string
  /** kernel: every customer's t_<hex>__kernel, as its purger role. platform: gremion_platform. */
  readonly scope: 'kernel' | 'platform'
  /** `name` in the public schema (kernel) or `plt.name` (platform). */
  readonly table: string
  /** The columns the rule reads: purge.test.ts checks them against the migrations. */
  readonly columns: readonly string[]
  /** SQL expression of the start event; a NULL start event (not yet happened) is never purged. */
  readonly startEvent: string
  /** Days after the start event. Positive whole number; never embedded in the SQL text. */
  readonly windowDays: number
  /** Why this reading of the catalogue row. */
  readonly note: string
}

export const PURGE_RULES: readonly PurgeRule[] = [
  {
    id: 'RC-K1-PLUMB/event_consumption',
    catalogueRow: 'RC-K1-PLUMB',
    profile: 'rp-<ctx>-plumbing',
    scope: 'kernel',
    table: 'event_consumption',
    columns: ['consumed_at'],
    startEvent: 'consumed_at',
    windowDays: 7,
    note: 'inbox (applied-event) rows: the 7-day de-duplication and inspection period after the event was applied',
  },
  {
    id: 'RC-K1-PLUMB/scheduled_notifications',
    catalogueRow: 'RC-K1-PLUMB',
    profile: 'rp-<ctx>-plumbing',
    scope: 'kernel',
    table: 'scheduled_notifications',
    columns: ['sent_at', 'failed_at'],
    startEvent: 'coalesce(sent_at, failed_at)',
    windowDays: 7,
    note: 'scheduled-task rows: 7 days after the job is done (sent) or dead (failed); a still-pending row has no start event and is never purged',
  },
  {
    id: 'RC-OPS-RUN/plt.job_run',
    catalogueRow: 'RC-OPS-RUN',
    windowFrom: 'RC-LOG-APP',
    profile: 'rp-plt-job-run-log',
    scope: 'platform',
    table: 'plt.job_run',
    columns: ['finished_at'],
    startEvent: 'finished_at',
    windowDays: 30,
    note: 'job runs follow RC-LOG-APP: 30 d regular window, 30 d cap [D R29-I6]',
  },
]

/** Every other catalogue row with a window-shaped entry, and why this runner does not purge it. */
export const PURGE_RESIDUAL: readonly { catalogueRow: string; partOf?: true; reason: string }[] = [
  { catalogueRow: 'RC-K1-PLUMB', partOf: true, reason: 'org_unit_event_outbox has no publish timestamp (status ok, created_at, occurred_at only); occurred_at is the logical event time, not "published", so a 7-day window cannot be anchored without inventing a start event' },
  { catalogueRow: 'RC-K1-SESS', reason: 'edit sessions and call sessions live in the files and messaging modules, which have no table in this repository' },
  { catalogueRow: 'RC-K1-DRAFT', reason: 'window is "on event" or "grace" (no number); autosave/forecast/branding-draft tables are not mapped in this repository' },
  { catalogueRow: 'RC-K1-RCPT', reason: 'window is "on event" (poll tallied, token expiry); on-event purges belong to the owning feature, and no table is mapped here' },
  { catalogueRow: 'RC-K1-IMPORT', reason: 'import rows are 7 days after a terminal state, but no import-rows table is in the kernel migrations; import files are on disk' },
  { catalogueRow: 'RC-K1-DERIVED', reason: 'window is "on event" (replaced when rebuilt); the projections are rebuilt by their owners' },
  { catalogueRow: 'RC-K1-TEST', reason: 'hard delete by test_run_id on event; no test_run_id column exists in the kernel tables' },
  { catalogueRow: 'RC-K1-CACHE', reason: 'enforced as a TTL in the cache configuration (catalogue 1.4), not as rows' },
  { catalogueRow: 'RC-LOG-ACC', reason: 'edge/log-store retention (logrotate, Vector, log store), not database rows' },
  { catalogueRow: 'RC-LOG-APP', reason: 'log-store retention; the one database table that follows this window (plt.job_run) is a rule above' },
  { catalogueRow: 'RC-LOG-SEC', reason: 'log-store retention; the kernel audit_log table is purged by the audit-retention tick in gremion-ui hooks.server.ts and its classification is open (catalogue 10, G6), so the hash-chained table is not touched here' },
  { catalogueRow: 'RC-LOG-FIN', reason: 'log-store retention, not database rows' },
  { catalogueRow: 'RC-LOG-AUD', reason: 'operator-access log; no table in this repository, and it must outlive a customer erasure' },
  { catalogueRow: 'RC-LOG-TRC', reason: 'trace-store retention, not database rows' },
  { catalogueRow: 'RC-NTF-NOTE', reason: 'the bell is an aggregated read model over other records; the only notification table here (notification_read_marker) is one row per user with no per-row start event; "grace" has no number' },
  { catalogueRow: 'RC-IDT-HELPER', reason: 'window is "grace" (no number in the catalogue)' },
  { catalogueRow: 'RC-IDT-GRANT', reason: 'window is "audit window" (no number in the catalogue); role_assignments / role_assignment_history are governance records (K3), not purged by a timer' },
  { catalogueRow: 'RC-IDT-IMPORT', reason: 'window is "grace" (no number in the catalogue)' },
  { catalogueRow: 'RC-TNT-DOM', reason: 'window is "grace" (no number in the catalogue)' },
  { catalogueRow: 'RC-OPS-RUN', partOf: true, reason: 'provisioning steps (plt.provisioning_step) are append-only by trigger and runbook evidence has an "audit window" without a number; only job runs are mapped' },
  { catalogueRow: 'RC-OPS-EXP', reason: 'window is "on event" (delivered, or the 30-day bound); export requests and manifests are not in this repository' },
  { catalogueRow: 'RC-MOD-EXPORT', reason: 'the module-disable pg_dump is a FILE (30-day grace), and K4 finance exports are kept to their hold: a file purge is a separate mechanism from a row purge' },
  { catalogueRow: 'RC-MOD-DATA', reason: 'provisional window ([D R29-I24], [A-MOD]) for modules without a database; no table is mapped in this repository' },
  { catalogueRow: 'RC-FIN-BOOKS', reason: 'K4 statutory finance hold in the finance module repository; not purged by a timer here' },
  { catalogueRow: 'RC-FIN-VOUCH', reason: 'K4 statutory finance hold in the finance module repository; not purged by a timer here' },
]

/** now - windowDays x 24 h. A window that is not a positive whole number of days is refused. */
export function purgeCutoff(now: Date, windowDays: number): Date {
  if (!Number.isInteger(windowDays) || windowDays < 1) {
    throw new RangeError(`retention window ${String(windowDays)} is not a positive whole number of days: a window with no derivation is not applied`)
  }
  return new Date(now.getTime() - windowDays * 86_400_000)
}

const PLAIN_TABLE = /^(plt\.)?[a-z_]+$/
const DEFAULT_BATCH = 5000
const MAX_BATCHES = 2000

/** One batch: delete up to $2 rows whose start event is older than $1; returns {n}. */
export function deleteBatchSql(rule: PurgeRule): string {
  if (!PLAIN_TABLE.test(rule.table)) throw new RangeError(`table ${JSON.stringify(rule.table)} is not a plain identifier`)
  const t = rule.scope === 'kernel' ? `public.${rule.table}` : rule.table
  return (
    `WITH d AS (DELETE FROM ${t} WHERE ctid IN (SELECT ctid FROM ${t} WHERE ${rule.startEvent} < $1::timestamptz LIMIT $2) RETURNING 1) ` +
    'SELECT count(*)::int AS n FROM d'
  )
}

export interface PurgeError {
  /** hex32 of the customer, null for a platform rule. */
  tenant: string | null
  rule: string
  message: string
}
export interface PurgeSkip {
  tenant: string
  rule: string
  reason: string
}

export interface PurgeDeps {
  /** gremion_platform, as its owner (the tenant-create container's own credential). */
  platform: Sql
  /** The kernel server (admin + open), as for ensureKernelDatabase. */
  server: ModuleServer
  /** The reference time of the cutoffs (tests pin it). */
  now?: () => Date
  /** The schedule slot this run answers; default the moment the run starts (UNIQUE with the job). */
  scheduledFor?: Date
  batchSize?: number
  log?: (line: string) => void
}

export interface PurgeResult {
  status: 'succeeded' | 'failed' | 'skipped'
  /** rows deleted per rule id, summed over all customers; every rule has an entry, 0 included. */
  categories: Record<string, number>
  errors: PurgeError[]
  skipped: PurgeSkip[]
  tenantsScanned: number
  jobRunId: string
  startedAt: Date
  finishedAt: Date
}

const KERNEL_DB = /^t_([0-9a-f]{32})__kernel$/
const MESSAGE_MAX = 300
const ERRORS_MAX = 50

function uuidOfHex(h: string): string {
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** SET LOCAL ROLE for a role name kernelRoles built from a validated tenant id (k_<hex32>_purger). */
function setRoleSql(role: string): string {
  if (!/^k_[0-9a-f]{32}_purger$/.test(role)) throw new RangeError(`${JSON.stringify(role)} is not a kernel purger role name`)
  return `SET LOCAL ROLE ${role}`
}

function messageOf(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err)
  return m.replaceAll(/\s+/g, ' ').slice(0, MESSAGE_MAX)
}

type Runner = (sql: string, params: unknown[]) => Promise<{ n: number }[]>

async function deleteAged(rule: PurgeRule, run: Runner, cutoff: Date, batch: number): Promise<number> {
  const sql = deleteBatchSql(rule)
  let total = 0
  for (let i = 0; i < MAX_BATCHES; i++) {
    const [row] = await run(sql, [cutoff.toISOString(), batch])
    const n = row?.n ?? 0
    total += n
    if (n < batch) return total
  }
  return total
}

/**
 * Runs every PURGE_RULES category once, records the run, returns the outcome.
 * Throws only when it cannot run at all or cannot record (no enabled platform
 * purge_run definition; the platform database unreachable); a failure inside a
 * customer database is part of the result.
 */
export async function runPurge(deps: PurgeDeps): Promise<PurgeResult> {
  const { platform, server } = deps
  const now = deps.now ?? (() => new Date())
  const batch = deps.batchSize ?? DEFAULT_BATCH
  const log = deps.log ?? (() => {})
  const rules = PURGE_RULES
  const startedAt = new Date()
  const scheduledFor = deps.scheduledFor ?? startedAt
  const reference = now()

  const conn = await platform.reserve()
  const lock = ADVISORY_LOCKS.purgeRun
  let held = false
  try {
    const [job] = await conn<{ id: string }[]>`
      SELECT scheduled_job_id::text AS id FROM plt.scheduled_job
       WHERE job_kind = 'purge_run' AND customer_id IS NULL AND enabled`
    if (!job) {
      throw new Error("plt.scheduled_job has no enabled platform 'purge_run' definition (platform migration 0012): refusing to purge with no record of it")
    }
    const [got] = await conn<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(${lock.classid}, ${lock.objid}) AS ok`
    held = got?.ok === true

    const categories: Record<string, number> = Object.fromEntries(rules.map((r) => [r.id, 0]))
    const errors: PurgeError[] = []
    const skipped: PurgeSkip[] = []
    let tenantsScanned = 0
    let status: PurgeResult['status'] = 'succeeded'

    if (!held) {
      status = 'skipped'
      log('purge: another run holds the lock; recording a skipped run and deleting nothing')
    } else {
      // --- kernel scope: every customer's kernel database, as its purger role
      const kernelRules = rules.filter((r) => r.scope === 'kernel')
      const dbs = await server.admin<{ datname: string }[]>`
        SELECT datname FROM pg_database WHERE datname ~ '^t_[0-9a-f]{32}__kernel$' AND datallowconn ORDER BY datname`
      for (const { datname } of dbs) {
        const hex = KERNEL_DB.exec(datname)?.[1]
        if (!hex) continue
        tenantsScanned++
        let db: Sql | undefined
        try {
          const purger = kernelRoles(uuidOfHex(hex)).purger
          const kdb: Sql = await server.open(datname)
          db = kdb
          for (const rule of kernelRules) {
            try {
              const [present] = await kdb<{ ok: boolean }[]>`SELECT to_regclass(${`public.${rule.table}`}) IS NOT NULL AS ok`
              if (!present?.ok) {
                skipped.push({ tenant: hex, rule: rule.id, reason: `table ${rule.table} is absent (the kernel chain has not created it)` })
                continue
              }
              // the purger holds exactly what the rule needs, nothing else (idempotent)
              await execFormatted(kdb, 'GRANT USAGE ON SCHEMA public TO %I', [purger])
              await execFormatted(kdb, `GRANT SELECT, DELETE ON TABLE public.${rule.table} TO %I`, [purger])
              const cutoff = purgeCutoff(reference, rule.windowDays)
              const n = await deleteAged(
                rule,
                async (sql, params) =>
                  kdb.begin(async (tx) => {
                    await tx.unsafe(setRoleSql(purger))
                    return (await tx.unsafe(sql, params as never[])) as unknown as { n: number }[]
                  }),
                cutoff,
                batch,
              )
              categories[rule.id] = (categories[rule.id] ?? 0) + n
            } catch (err) {
              errors.push({ tenant: hex, rule: rule.id, message: messageOf(err) })
            }
          }
        } catch (err) {
          errors.push({ tenant: hex, rule: '*', message: messageOf(err) })
        } finally {
          await db?.end({ timeout: 5 }).catch(() => {})
        }
      }
      // --- platform scope: the connection's own role
      for (const rule of rules.filter((r) => r.scope === 'platform')) {
        try {
          const cutoff = purgeCutoff(reference, rule.windowDays)
          const n = await deleteAged(rule, async (sql, params) => (await conn.unsafe(sql, params as never[])) as unknown as { n: number }[], cutoff, batch)
          categories[rule.id] = (categories[rule.id] ?? 0) + n
        } catch (err) {
          errors.push({ tenant: null, rule: rule.id, message: messageOf(err) })
        }
      }
      if (errors.length > 0) status = 'failed'
    }

    const finishedAt = new Date(Math.max(Date.now(), startedAt.getTime()))
    const detail = {
      reference_time: reference.toISOString(),
      categories,
      tenants_scanned: tenantsScanned,
      errors: errors.slice(0, ERRORS_MAX),
      errors_total: errors.length,
      skipped: skipped.slice(0, ERRORS_MAX),
      ...(status === 'skipped' ? { reason: 'another purge run holds the lock' } : {}),
    }
    const [row] = await conn<{ id: string }[]>`
      INSERT INTO plt.job_run (scheduled_job_id, scope, scheduled_for, started_at, finished_at, status, detail_ref, detail)
      VALUES (${job.id}::uuid, 'platform', ${scheduledFor}, ${status === 'skipped' ? null : startedAt}, ${finishedAt}, ${status},
              ${`purge/${reference.toISOString().replace(/\.\d+Z$/, 'Z')}`}, ${conn.json(detail as unknown as Parameters<typeof conn.json>[0])})
      RETURNING job_run_id::text AS id`
    return { status, categories, errors, skipped, tenantsScanned, jobRunId: row!.id, startedAt, finishedAt }
  } finally {
    if (held) await conn`SELECT pg_advisory_unlock(${lock.classid}, ${lock.objid})`.catch(() => {})
    conn.release()
  }
}
