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
// AS WHOM: a kernel-scope rule runs as the customer's k_<hex>_purger role, and
// the run LOGS IN as that role: it is the session user, not a SET ROLE inside
// an admin session. The kernel server's admin is a superuser and the customer's
// app role is a member of the table owner (TASK-192 deviation), so the tenant
// can attach code (a trigger, a rule, an RLS policy, an ON DELETE CASCADE into
// its own table) to a purge table; under SET ROLE that code could RESET ROLE
// back to the superuser (verified on postgres:18: `RESET ROLE; ALTER ROLE
// k_<hex>_app SUPERUSER`). Logged in as the purger, RESET ROLE returns to the
// purger, which is NOSUPERUSER and a member of nothing.
//   Why a per-customer login and not one platform-wide purge role granted
// membership in every k_*_purger: the shared role would be the RESET ROLE
// target of every customer's session, a role that can SET ROLE into every
// other customer's purger. Why a one-run password and not a stored secret: no
// credential exists at rest. The admin connection (maintenance database only,
// never a customer database) gives the purger LOGIN and the SCRAM verifier of a
// random password VALID UNTIL the run's deadline + 60 s, the run logs in with
// it, and the `finally` puts the role back to NOLOGIN PASSWORD NULL (a crashed
// run leaves a verifier that has already expired). The admin only ever runs
// role DDL, GRANTs and catalogue reads; inside a customer database
// (ensureKernelPurgeGrants) it does so with search_path pinned to pg_catalog
// (kernel.ts asAdminIn) and every function qualified, because the owner may
// ALTER DATABASE SET search_path and plant a public.format that the superuser
// would otherwise call.
//   The purger holds CONNECT and USAGE on public from ensureKernelDatabase and
// SELECT + DELETE on exactly the mapped tables from ensureKernelPurgeGrants
// (the tenant init path, after the kernel chain created them): a table with no
// rule (audit_log, the governance records) is out of reach by privilege, not
// by the SQL text. audit_log is a governance record (RC-GOV-CHAIN): no rule
// ever deletes from it, and ensureKernelAuditAppendOnly (audit-append-only.ts)
// takes DELETE, UPDATE and TRUNCATE on it from the app and owner roles. A run that finds a grant missing records it and deletes
// nothing there; it never grants.
//   Defence in depth, per table and before any DELETE: the run refuses (records
// an error, skips the table) when the table is not a plain table, has a child
// table, has row-level security, a non-internal trigger outside the kernel's
// own (PurgeRule.kernelTriggers, checked against the migrations by
// purge.test.ts), a rewrite rule, or a foreign key pointing at it. Every
// statement runs in a transaction with search_path pinned to pg_catalog (the
// owner may ALTER DATABASE SET search_path) and statement_timeout bounded by
// the deadline. The platform-scope rule (plt.job_run) runs as the platform
// connection's own role: gremion_platform has no purger role and no tenant
// writes to it, and job_run's DELETE is open by design (0005: "a DELETE must
// stay possible for the retention purge").
//
// DEADLINE: gremion-purge.service has TimeoutStartSec=170 and the job_run row
// is written at the end, so the run stops itself at PURGE_DEADLINE_MS (checked
// before every database, rule and batch, and every statement's timeout is the
// time left) and records a partial result (status failed, detail.partial =
// 'deadline'). A rule that stops at the batch cap is recorded too
// (detail.batch_limit_hits). Either way the next day's run continues.
//
// SAFE TO RE-RUN: every rule is "delete rows whose start event is older than
// now - window", so a second run deletes 0 and still writes its own job_run row.
// One run at a time (advisory lock on gremion_platform); a second concurrent run
// writes a `skipped` row and deletes nothing. A run with no enabled platform
// purge_run definition refuses before it deletes anything (a purge with no record
// is not run). A failure in one customer database or rule is recorded and the
// rest still run; the row's status is then `failed`.
import { randomBytes } from 'node:crypto'
import type { Sql } from '@gremion/db'
import { ADVISORY_LOCKS } from '../advisory-locks.js'
import { execFormatted, sqlState } from './ddl.js'
import { asAdminIn, kernelDbName, kernelRoles } from './kernel.js'
import { scramSha256Verifier } from './scram.js'
import type { ModuleServer } from './types.js'

/** The schedule of the platform purge_run definition (02:30 UTC daily); gremion-purge.timer fires the same moment. */
export const PURGE_CRON = '30 2 * * *'

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
  /**
   * Kernel scope: the non-internal triggers the kernel's own migrations put on
   * the table (purge.test.ts re-reads gremion-ui/migrations). Any other trigger
   * makes the run refuse the table: it would run during the purge's DELETE.
   */
  readonly kernelTriggers?: readonly string[]
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
    kernelTriggers: [],
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
    kernelTriggers: [],
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
    windowDays: 29,
    note: 'job runs follow RC-LOG-APP: 30 d regular window, 30 d cap [D R29-I6]; the run is daily, so the window is cap - 1 tick = 29 d (registry dbWindowDays, derived by purge.test.ts)',
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
  { catalogueRow: 'RC-LOG-SEC', reason: 'log-store retention (Loki, rendered by @gremion/retention render). The kernel audit_log table is NOT a log-store row: it is a governance record (RC-GOV-CHAIN, operator decision 2026-10-28), no timer purges it, and the app role holds no DELETE, UPDATE or TRUNCATE on it (ensureKernelAuditAppendOnly)' },
  { catalogueRow: 'RC-LOG-FIN', reason: 'log-store retention, not database rows' },
  { catalogueRow: 'RC-LOG-AUD', reason: 'operator-access log; its Loki stream is rendered by @gremion/retention, and the oac.access_record table has its own host unit (gremion-access-purge, the executor trust boundary); it must outlive a customer erasure' },
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
/**
 * The run's own deadline. Budget of gremion-purge.service (TimeoutStartSec=170):
 * purge.sh's host-lock wait (PURGE_LOCK_WAIT, default 20 s) + the one-shot's
 * start (~15 s) + this + the job_run write and teardown (< 25 s). purge.bats
 * checks the sum.
 */
export const PURGE_DEADLINE_MS = 110_000

/** One batch: delete up to $2 rows whose start event is older than $1; returns {n}. ONLY: never a child table. */
export function deleteBatchSql(rule: PurgeRule): string {
  if (!PLAIN_TABLE.test(rule.table)) throw new RangeError(`table ${JSON.stringify(rule.table)} is not a plain identifier`)
  const t = rule.scope === 'kernel' ? `public.${rule.table}` : rule.table
  return (
    `WITH d AS (DELETE FROM ONLY ${t} WHERE ctid IN (SELECT ctid FROM ONLY ${t} WHERE ${rule.startEvent} < $1::pg_catalog.timestamptz LIMIT $2) RETURNING 1) ` +
    'SELECT pg_catalog.count(*)::int AS n FROM d'
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

export interface PurgeBatchLimit {
  tenant: string | null
  rule: string
  batches: number
}

/** The kernel server as the purge run needs it: the admin, and a login as another role. */
export interface PurgeServer extends ModuleServer {
  /**
   * A DIRECT pool to `database` on this server that LOGS IN as `user` with
   * `password` (never the admin's credential, never a pooler). The
   * implementation should send search_path=pg_catalog as a startup parameter;
   * the run pins it per transaction regardless. The caller ends the pool.
   */
  login(database: string, user: string, password: string): Sql | Promise<Sql>
}

export interface PurgeDeps {
  /** gremion_platform, as its owner (the tenant-create container's own credential). */
  platform: Sql
  /** The kernel server: admin (maintenance database, role DDL only) + login as each purger. */
  server: PurgeServer
  /** Stop after this many ms and record a partial run (default PURGE_DEADLINE_MS). */
  deadlineMs?: number
  /** Batches per rule and database before the run moves on and records the cap (default 2000). */
  maxBatches?: number
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
  /** Rules that stopped at the batch cap (rows may remain). */
  batchLimitHits: PurgeBatchLimit[]
  /** 'deadline' when the run stopped itself before it finished; null otherwise. */
  partial: 'deadline' | null
  tenantsScanned: number
  jobRunId: string
  startedAt: Date
  finishedAt: Date
}

const KERNEL_DB = /^t_([0-9a-f]{32})__kernel$/
const PURGER = /^k_[0-9a-f]{32}_purger$/
const MESSAGE_MAX = 300
const ERRORS_MAX = 50

function uuidOfHex(h: string): string {
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function messageOf(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err)
  return m.replaceAll(/\s+/g, ' ').slice(0, MESSAGE_MAX)
}

/** The run stopped itself: not an error of the database it was in. */
class DeadlineReached extends Error {}

interface Clock {
  /** ms left, at least 1 (a statement_timeout of 0 would mean "none"). */
  left(): number
  expired(): boolean
  /** throws DeadlineReached when expired */
  check(): void
}

function clockOf(deadlineAt: number): Clock {
  return {
    left: () => Math.max(1, deadlineAt - Date.now()),
    expired: () => Date.now() >= deadlineAt,
    check() {
      if (Date.now() >= deadlineAt) throw new DeadlineReached('the purge run reached its deadline')
    },
  }
}

/**
 * One transaction with the name resolution and the time bound pinned: the
 * customer's owner may ALTER DATABASE SET search_path, and a statement must
 * never outlive the run's deadline.
 */
async function pinned<T>(db: Sql, clock: Clock, fn: (tx: Sql) => Promise<T>): Promise<T> {
  clock.check()
  return (await db.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path = pg_catalog; SET LOCAL statement_timeout = ${String(Math.ceil(clock.left()))}`)
    return fn(tx as unknown as Sql)
  })) as T
}

/**
 * One transaction on `db` whose lock waits and statements end within `ms`: the
 * admin's role DDL (ALTER ROLE waits on the role's row lock) and catalogue
 * reads must not outlive the run's deadline either.
 */
async function bounded<T>(db: Sql, ms: number, fn: (tx: Sql) => Promise<T>): Promise<T> {
  const t = String(Math.max(1, Math.ceil(ms)))
  return (await db.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path = pg_catalog; SET LOCAL lock_timeout = ${t}; SET LOCAL statement_timeout = ${t}`)
    return fn(tx as unknown as Sql)
  })) as T
}

/** The bound of the reset to NOLOGIN: it runs after the deadline too, so it has its own. */
const RESET_BOUND_MS = 5000

type Runner = (sql: string, params: unknown[]) => Promise<{ n: number }[]>

/**
 * Batches until fewer than `batch` rows are left, the cap, or a failure. Each
 * batch commits on its own, so a failure (the deadline, a statement timeout,
 * any error) still returns the rows the committed batches removed, with the
 * error in `stopped`: the caller records the count, then handles the error.
 */
async function deleteAged(
  rule: PurgeRule,
  run: Runner,
  cutoff: Date,
  batch: number,
  maxBatches: number,
  clock: Clock,
): Promise<{ total: number; limitHit: boolean; stopped?: unknown }> {
  const sql = deleteBatchSql(rule)
  let total = 0
  try {
    for (let i = 0; i < maxBatches; i++) {
      clock.check()
      const [row] = await run(sql, [cutoff.toISOString(), batch])
      const n = row?.n ?? 0
      total += n
      if (n < batch) return { total, limitHit: false }
    }
  } catch (err) {
    return { total, limitHit: false, stopped: err }
  }
  return { total, limitHit: true }
}

/**
 * The SELECT + DELETE grants of the purger on exactly the kernel-scope purge
 * tables (idempotent). The tenant init path calls it after the kernel chain
 * created them; a table the chain has not created yet is returned in `absent`.
 * Executed by the admin with search_path pinned (asAdminIn): a GRANT fires no
 * tenant code, and no name here resolves to an object the owner planted.
 */
export async function ensureKernelPurgeGrants(server: ModuleServer, tenantId: string): Promise<{ granted: string[]; absent: string[] }> {
  const { purger } = kernelRoles(tenantId)
  const dbName = kernelDbName(tenantId)
  const db = await server.open(dbName)
  const granted: string[] = []
  const absent: string[] = []
  try {
    await asAdminIn(db, async (tx) => {
      const [who] = await tx<{ db: string }[]>`SELECT pg_catalog.current_database() AS db`
      if (who?.db !== dbName) throw new Error(`the admin pool is connected to ${JSON.stringify(who?.db)}, not ${dbName}`)
      await execFormatted(tx, 'GRANT USAGE ON SCHEMA public TO %I', [purger])
      for (const rule of PURGE_RULES.filter((r) => r.scope === 'kernel')) {
        if (!PLAIN_TABLE.test(rule.table)) throw new RangeError(`table ${JSON.stringify(rule.table)} is not a plain identifier`)
        const [present] = await tx<{ ok: boolean }[]>`SELECT pg_catalog.to_regclass(${`public.${rule.table}`}::pg_catalog.text) IS NOT NULL AS ok`
        if (!present?.ok) {
          absent.push(rule.table)
          continue
        }
        await execFormatted(tx, `GRANT SELECT, DELETE ON TABLE public.${rule.table} TO %I`, [purger])
        granted.push(rule.table)
      }
    })
  } finally {
    await db.end({ timeout: 5 })
  }
  return { granted, absent }
}

/** What the run reads about a purge table before it deletes from it. */
export interface PurgeTableShape {
  kind: string
  children: number
  rls: boolean
  granted: boolean
  triggers: readonly string[]
  policies: readonly string[]
  rules: readonly string[]
  referencedBy: readonly string[]
}

/** Why the run must not DELETE from this table, or null. */
export function refusalOf(rule: PurgeRule, t: PurgeTableShape): string | null {
  if (t.kind !== 'r') return `refused: ${rule.table} is not a plain table (relkind ${t.kind})`
  if (t.children > 0) return `refused: ${rule.table} has ${String(t.children)} child table(s)`
  if (t.rls || t.policies.length > 0) return `refused: ${rule.table} has row-level security${t.policies.length ? ` (policy ${t.policies.join(', ')})` : ''}`
  const allowed = new Set(rule.kernelTriggers ?? [])
  const foreign = t.triggers.filter((n) => !allowed.has(n))
  if (foreign.length > 0) return `refused: ${rule.table} has trigger ${foreign.join(', ')} that the kernel migrations do not create`
  if (t.rules.length > 0) return `refused: ${rule.table} has rewrite rule ${t.rules.join(', ')}`
  if (t.referencedBy.length > 0) return `refused: ${rule.table} is referenced by foreign key ${t.referencedBy.join(', ')}`
  if (!t.granted) {
    return `refused: the purger lacks SELECT, DELETE on ${rule.table} (ensureKernelPurgeGrants has not run for this customer since the kernel chain created it)`
  }
  return null
}

/** The name lists of a shape row, each a real string array: anything else fails loudly, never misread. */
export function readShape(row: Record<string, unknown> | undefined): PurgeTableShape | undefined {
  if (!row) return undefined
  const names = (key: string): string[] => {
    const v = row[key]
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      throw new TypeError(`purge table shape: ${key} is not a list of names (${JSON.stringify(v)})`)
    }
    return v
  }
  return {
    kind: String(row.kind),
    children: Number(row.children),
    rls: row.rls === true,
    granted: row.granted === true,
    triggers: names('triggers'),
    policies: names('policies'),
    rules: names('rules'),
    referencedBy: names('referencedBy'),
  }
}

// The four name lists come back as json, not text[]: the purger's session reads without fetching array
// types, so a text[] arrived as its literal ('{}', length 2) and refusalOf saw a policy on every table and
// threw on .join (Linux customer proof, purge-run: "t.policies.join is not a function" on every rule).
const SHAPE_SQL = `
  SELECT c.relkind::text AS kind,
         (SELECT count(*)::int FROM pg_catalog.pg_inherits i WHERE i.inhparent = c.oid) AS children,
         c.relrowsecurity AS rls,
         pg_catalog.has_table_privilege(c.oid, 'SELECT') AND pg_catalog.has_table_privilege(c.oid, 'DELETE') AS granted,
         pg_catalog.to_json(ARRAY(SELECT t.tgname::text FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal ORDER BY 1)) AS triggers,
         pg_catalog.to_json(ARRAY(SELECT p.polname::text FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid ORDER BY 1)) AS policies,
         pg_catalog.to_json(ARRAY(SELECT r.rulename::text FROM pg_catalog.pg_rewrite r WHERE r.ev_class = c.oid AND r.rulename <> '_RETURN' ORDER BY 1)) AS rules,
         pg_catalog.to_json(ARRAY(SELECT f.conname::text FROM pg_catalog.pg_constraint f WHERE f.confrelid = c.oid AND f.contype = 'f' ORDER BY 1)) AS "referencedBy"
    FROM pg_catalog.pg_class c WHERE c.oid = pg_catalog.to_regclass($1)`

/**
 * Logs in to the customer's kernel database AS its purger (exported for the
 * integration test of the identity). The admin, on the maintenance database,
 * gives the purger LOGIN and a one-run password VALID UNTIL `validUntil`;
 * `close` ends the pool and puts the role back to NOLOGIN PASSWORD NULL.
 * Refuses a purger that is not the NOSUPERUSER, member-of-nothing role
 * ensureKernelRoles made. `bound` is the ms its statements may take (the run
 * passes the time left before its deadline).
 */
export async function openPurgerSession(
  server: PurgeServer,
  hex: string,
  validUntil: Date,
  bound: () => number = () => 15_000,
): Promise<{ db: Sql; purger: string; close(): Promise<void> }> {
  const tenantId = uuidOfHex(hex)
  const { purger } = kernelRoles(tenantId)
  if (!PURGER.test(purger)) throw new RangeError(`${JSON.stringify(purger)} is not a kernel purger role name`)
  const password = randomBytes(32).toString('base64url')
  await bounded(server.admin, bound(), async (tx) => {
    const [r] = await tx<{ ok: boolean; members: number }[]>`
      SELECT NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication) AS ok,
             (SELECT count(*)::int FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS members
        FROM pg_catalog.pg_roles r WHERE r.rolname = ${purger}`
    if (!r) throw new Error(`${purger} does not exist (ensureKernelDatabase has not run for this customer)`)
    if (!r.ok || r.members !== 0) {
      throw new Error(`refused: ${purger} is not the plain role ensureKernelRoles makes (attributes or memberships changed); not logging in as it`)
    }
    await execFormatted(tx, 'ALTER ROLE %I LOGIN PASSWORD %L VALID UNTIL %L', [purger, scramSha256Verifier(password), validUntil.toISOString()])
  })
  const reset = () => bounded(server.admin, RESET_BOUND_MS, (tx) => execFormatted(tx, 'ALTER ROLE %I NOLOGIN PASSWORD NULL VALID UNTIL %L', [purger, 'infinity']))
  let db: Sql | undefined
  try {
    db = await server.login(kernelDbName(tenantId), purger, password)
    const [who] = await bounded(db, bound(), (tx) => tx<{ su: string; cu: string; sup: boolean }[]>`
      SELECT session_user::text AS su, current_user::text AS cu,
             (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = session_user) AS sup`)
    // strict: a NULL rolsuper is not proof of NOSUPERUSER
    if (who?.su !== purger || who.cu !== purger || who.sup !== false) {
      throw new Error(`refused: the purge session is ${JSON.stringify(who?.su)}/${JSON.stringify(who?.cu)}, not ${purger}`)
    }
  } catch (err) {
    await db?.end({ timeout: 5 }).catch(() => {})
    await reset().catch(() => {})
    throw err
  }
  const opened = db
  return {
    db: opened,
    purger,
    async close() {
      await opened.end({ timeout: 5 }).catch(() => {})
      await reset()
    },
  }
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
  const maxBatches = deps.maxBatches ?? MAX_BATCHES
  const log = deps.log ?? (() => {})
  const rules = PURGE_RULES
  const startedAt = new Date()
  const deadlineMs = deps.deadlineMs ?? PURGE_DEADLINE_MS
  const deadlineAt = startedAt.getTime() + deadlineMs
  const clock = clockOf(deadlineAt)
  const scheduledFor = deps.scheduledFor ?? startedAt
  const reference = now()

  const conn = await platform.reserve()
  const lock = ADVISORY_LOCKS.purgeRun
  let held = false
  try {
    // the definition is upserted here, not seeded by a migration (the expand lint refuses an
    // INSERT into an existing table); ON CONFLICT DO NOTHING keeps a disabled definition disabled
    await conn`
      INSERT INTO plt.scheduled_job (scope, job_kind, cron_expression, created_by_kind, updated_by_kind)
      VALUES ('platform', 'purge_run', ${PURGE_CRON}, 'system', 'system')
      ON CONFLICT DO NOTHING`
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
    const batchLimitHits: PurgeBatchLimit[] = []
    let partial: PurgeResult['partial'] = null
    let tenantsScanned = 0
    let status: PurgeResult['status'] = 'succeeded'
    /** true when the error is the run's own deadline (recorded as partial, not as an error of that database) */
    const deadlineHit = (err: unknown): boolean => {
      // 57014 statement_timeout, 55P03 lock_timeout: both are set to the time left
      if (err instanceof DeadlineReached || ((sqlState(err) === '57014' || sqlState(err) === '55P03') && clock.expired())) {
        partial = 'deadline'
        return true
      }
      return false
    }

    if (!held) {
      status = 'skipped'
      log('purge: another run holds the lock; recording a skipped run and deleting nothing')
    } else {
      // --- platform scope first (cheap, never starved by the deadline): the connection's own role
      for (const rule of rules.filter((r) => r.scope === 'platform')) {
        try {
          const cutoff = purgeCutoff(reference, rule.windowDays)
          // gremion_platform takes no tenant writes: only the time bound is pinned (on the reserved connection)
          const r = await deleteAged(
            rule,
            async (sql, params) => {
              await conn.unsafe(`SET statement_timeout = ${String(Math.ceil(clock.left()))}`)
              return (await conn.unsafe(sql, params as never[])) as unknown as { n: number }[]
            },
            cutoff,
            batch,
            maxBatches,
            clock,
          )
          categories[rule.id] = (categories[rule.id] ?? 0) + r.total
          if (r.stopped !== undefined) throw r.stopped
          if (r.limitHit) batchLimitHits.push({ tenant: null, rule: rule.id, batches: maxBatches })
        } catch (err) {
          if (!deadlineHit(err)) errors.push({ tenant: null, rule: rule.id, message: messageOf(err) })
        } finally {
          await conn`RESET statement_timeout`
        }
      }
      // --- kernel scope: every customer's kernel database, LOGGED IN as its purger role
      const kernelRules = rules.filter((r) => r.scope === 'kernel')
      let dbs: { datname: string; owner: string }[] = []
      try {
        if (partial === null) {
          dbs = await bounded(server.admin, clock.left(), (tx) => tx<{ datname: string; owner: string }[]>`
            SELECT d.datname, r.rolname AS owner FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba
             WHERE d.datname ~ '^t_[0-9a-f]{32}__kernel$' AND d.datallowconn ORDER BY d.datname`)
        }
      } catch (err) {
        if (!deadlineHit(err)) errors.push({ tenant: null, rule: '*', message: messageOf(err) })
      }
      for (const { datname, owner } of dbs) {
        if (partial !== null || clock.expired()) {
          partial = 'deadline'
          break
        }
        const hex = KERNEL_DB.exec(datname)?.[1]
        if (!hex) continue
        tenantsScanned++
        // ensureKernelDatabase refuses to adopt a database it did not create; the purge does not log in to one either
        if (owner !== kernelRoles(uuidOfHex(hex)).owner) {
          for (const rule of kernelRules) skipped.push({ tenant: hex, rule: rule.id, reason: `${datname} is owned by ${owner}, not the lifecycle's owner role: not a lifecycle kernel database` })
          continue
        }
        let session: Awaited<ReturnType<typeof openPurgerSession>> | undefined
        try {
          session = await openPurgerSession(server, hex, new Date(deadlineAt + 60_000), () => clock.left())
          const kdb = session.db
          for (const rule of kernelRules) {
            if (partial !== null) break
            try {
              const shape = readShape(await pinned(kdb, clock, async (tx) => ((await tx.unsafe(SHAPE_SQL, [`public.${rule.table}`])) as unknown as Record<string, unknown>[])[0]))
              if (!shape) {
                skipped.push({ tenant: hex, rule: rule.id, reason: `table ${rule.table} is absent (the kernel chain has not created it)` })
                continue
              }
              const refused = refusalOf(rule, shape)
              if (refused) {
                errors.push({ tenant: hex, rule: rule.id, message: refused })
                continue
              }
              const cutoff = purgeCutoff(reference, rule.windowDays)
              const r = await deleteAged(
                rule,
                async (sql, params) => pinned(kdb, clock, async (tx) => (await tx.unsafe(sql, params as never[])) as unknown as { n: number }[]),
                cutoff,
                batch,
                maxBatches,
                clock,
              )
              categories[rule.id] = (categories[rule.id] ?? 0) + r.total
              if (r.stopped !== undefined) throw r.stopped
              if (r.limitHit) batchLimitHits.push({ tenant: hex, rule: rule.id, batches: maxBatches })
            } catch (err) {
              if (!deadlineHit(err)) errors.push({ tenant: hex, rule: rule.id, message: messageOf(err) })
            }
          }
        } catch (err) {
          if (!deadlineHit(err)) errors.push({ tenant: hex, rule: '*', message: messageOf(err) })
        } finally {
          await session?.close().catch((err: unknown) => {
            errors.push({ tenant: hex, rule: '*', message: `could not put the purger back to NOLOGIN: ${messageOf(err)}` })
          })
        }
      }
      // incomplete is not succeeded: an error, the deadline, or a rule cut at the batch cap
      if (errors.length > 0 || partial !== null || batchLimitHits.length > 0) status = 'failed'
      if (partial !== null) log(`purge: stopped at the ${String(deadlineMs)} ms deadline; recording a partial run`)
    }

    const finishedAt = new Date(Math.max(Date.now(), startedAt.getTime()))
    const detail = {
      reference_time: reference.toISOString(),
      categories,
      tenants_scanned: tenantsScanned,
      errors: errors.slice(0, ERRORS_MAX),
      errors_total: errors.length,
      skipped: skipped.slice(0, ERRORS_MAX),
      batch_limit_hits: batchLimitHits.slice(0, ERRORS_MAX),
      partial,
      deadline_ms: deadlineMs,
      ...(status === 'skipped' ? { reason: 'another purge run holds the lock' } : {}),
    }
    const [row] = await conn<{ id: string }[]>`
      INSERT INTO plt.job_run (scheduled_job_id, scope, scheduled_for, started_at, finished_at, status, detail_ref, detail)
      VALUES (${job.id}::uuid, 'platform', ${scheduledFor}, ${status === 'skipped' ? null : startedAt}, ${finishedAt}, ${status},
              ${`purge/${reference.toISOString().replace(/\.\d+Z$/, 'Z')}`}, ${conn.json(detail as unknown as Parameters<typeof conn.json>[0])})
      RETURNING job_run_id::text AS id`
    return { status, categories, errors, skipped, batchLimitHits, partial, tenantsScanned, jobRunId: row!.id, startedAt, finishedAt }
  } finally {
    if (held) await conn`SELECT pg_advisory_unlock(${lock.classid}, ${lock.objid})`.catch(() => {})
    conn.release()
  }
}
