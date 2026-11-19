// modules/calendar/src/migrate-only.ts
//
// The CD leaf step: `node dist/index.js --migrate-only`.
//
// What it is for. Continuous deployment migrates a leaf's per-customer databases BEFORE the new
// colour serves traffic, under its own control and after a dump, instead of leaving it to the
// scheduler's first tick about 30 seconds after start. This entry goes through every catalogued
// customer inside ONE process (the host never loops over customers and never sees a name), runs the
// leaf's own migration runner on each existing database, prints one JSON line of counts and exits.
//
// What it does NOT do:
//   - it never calls listTenants() or anything else that creates the control database
//     (ensureControlDb creates it, and the catalogue table, when missing). It looks first: no
//     `<prefix>control` database, or no catalogue table, is "nothing to do" (total 0, exit 0), and
//     neither is created;
//   - it never creates a customer database. A catalogued customer whose database does not exist is
//     `skipped`. The leaf's own storeFor() would create it, so storeFor() is only ever called for a
//     database that exists AND that this process holds an advisory-lock connection to (a database that
//     somebody drops in between cannot be dropped while that connection is open, and a connect error
//     "does not exist" is a skip, not a create);
//   - it starts no HTTP server, no scheduler, no NATS client and no outbox relay (index.ts branches
//     before any of those is built) and it takes no slug argument.
//
// Streams. Customer databases are named after the customer slug, so a name must never reach a log.
// The only thing written to stdout is the counts line; every console method is silenced for the
// run (a library notice would otherwise break "exactly one line"); no error text is ever printed.
//
// Locking. Each customer database is migrated under a session advisory lock held on its own
// connection, so two entries on one database run one after the other (the second finds every file
// already applied; the files are idempotent). The old colour's runner takes no lock: its collision with
// this entry is handled by the retry of the catalogue-race errors below, never by the lock.
//
// Exit codes: 0 ok; 1 a migration file raised SQL (or its hash differs from manifest.json); 2 usage,
// a missing CALENDAR_PG_URL, or a refused login (a host configuration fault, not the commit's);
// 3 a connection that was refused, timed out or dropped before any DDL, or a catalogue-race error
// that persisted after the retries (retry later, not a defect of the commit). A connection lost INSIDE
// a migration file is 1.

import postgres from 'postgres'
import { evictTenantPools, requireRuntimePgUrl, type StoreForOptions, type TenantRef } from './tenant-store.js'

const LEAF = 'calendar'
const PG_URL_ENV = 'CALENDAR_PG_URL'
const DEFAULT_DB_PREFIX = 'calendar_'

/** The session advisory lock every entry takes on a customer database (hashed to a bigint in SQL). */
export const MIGRATE_LOCK_NAME = 'gremion.leaf.migrate-only'
/** One attempt plus three retries of a catalogue-race error. */
export const MAX_ATTEMPTS = 4
const DEFAULT_RETRY_DELAY_MS = 2000

export interface MigrateOnlyCounts {
  v: 1
  total: number
  migrated: number
  skipped: number
  failed: number
}

export type FailureClass = 'race' | 'unreachable' | 'precondition' | 'sql'

export interface MigrateOnlyResult {
  code: 0 | 1 | 2 | 3
  counts: MigrateOnlyCounts
  /** With code 2: what is wrong (fixed words, never a value). */
  reason?: 'env' | 'login'
}

/**
 * The leaf's own store opener, handed in by the process wiring (index.ts is the one place that may call
 * it: the identity-binding guard enumerates the call sites). It creates the database when missing and
 * runs the leaf's runner when it is not yet in the pool registry.
 */
export type OpenStoreFn = (tenant: TenantRef, options: StoreForOptions) => Promise<unknown>

export interface MigrateOnlyDeps {
  openStore: OpenStoreFn
}

/** Migrates one existing customer database with the leaf's own runner. Replaceable in tests. */
export type MigrateFn = (
  tenant: TenantRef,
  ctx: { pgUrl: string; dbPrefix: string; manifest?: Record<string, string> },
) => Promise<void>

export interface MigrateOnlyOptions {
  pgUrl?: string
  dbPrefix?: string
  /** Pause between the attempts of a catalogue-race error. */
  retryDelayMs?: number
  /** Test seam: replaces the leaf's runner (the default opens the store through deps.openStore). */
  migrate?: MigrateFn
  /** Test seam: a manifest that replaces manifest.json (a bad hash must fail the customer). */
  manifest?: Record<string, string>
}

// ── error classes ─────────────────────────────────────────────────────────────

const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'CONNECT_TIMEOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  '57P03', // the database system is starting up
  '53300', // too many connections
  '08001', // the client could not establish the connection
])

/**
 * A connection that dropped. Before any DDL (the catalogue read, the existence look, the lock) it is
 * "retry later"; inside a migration file it is a defect of that run and stays 1.
 */
const CONNECTION_LOST_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'EPIPE',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '08006', // connection_failure
  '08003', // connection_does_not_exist
])

/** The catalogue races of concurrent IF NOT EXISTS DDL (the old runner takes no lock). */
const RACE_CODES: ReadonlySet<string> = new Set(['42710', '42P07', '40P01', '40001'])

function codeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Sort a failure into what the host should do about it. A connection that was refused or timed out
 * never reached a statement, so it is "retry later" (3), as is a catalogue race that the retries did not
 * clear; a connection lost INSIDE a file (ECONNRESET, CONNECTION_CLOSED) and every other error stays a
 * defect of the commit (1).
 */
export function classifyFailure(err: unknown, phase: 'before-ddl' | 'in-migration' = 'in-migration'): FailureClass {
  const nested = typeof err === 'object' && err !== null ? (err as { errors?: unknown }).errors : undefined
  if (Array.isArray(nested) && nested.length > 0) {
    // Node reports a refused localhost connection as an AggregateError over the address families.
    const classes = nested.map((e) => classifyFailure(e, phase))
    if (classes.every((c) => c === 'unreachable')) return 'unreachable'
  }
  const code = codeOf(err)
  if (code === undefined) return 'sql'
  if (UNREACHABLE_CODES.has(code)) return 'unreachable'
  // A refused login (class 28) is the host's credentials, not the commit.
  if (code.startsWith('28')) return 'precondition'
  if (phase === 'before-ddl' && CONNECTION_LOST_CODES.has(code)) return 'unreachable'
  if (RACE_CODES.has(code)) return 'race'
  if (code === 'XX000' && err instanceof Error && err.message.includes('tuple concurrently updated')) {
    // Two sessions replacing the same function (content 002, publishing 001): the loser fails with this
    // internal-error code and no other. It clears on the next attempt.
    return 'race'
  }
  if (code === '23505') {
    // A unique violation of a pg_ catalogue index is two sessions creating the same object; a unique
    // violation of a user table is a real defect.
    const constraint = (err as { constraint_name?: unknown }).constraint_name
    if (typeof constraint === 'string' && constraint.startsWith('pg_')) return 'race'
  }
  return 'sql'
}

// ── identifiers ───────────────────────────────────────────────────────────────

// The same grammar the leaf's storeFor() holds a slug to (and the reserved catalogue name). It is
// checked here too because this entry builds a connection URL from `<prefix><slug>` before storeFor()
// is reached: a hostile catalogue row is counted `failed` and never reaches a URL or a stream.
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$/
const TENANT_ID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function isServableRow(row: { id: string; slug: string }): boolean {
  return TENANT_ID_TEXT.test(row.id) && SLUG_PATTERN.test(row.slug) && row.slug !== 'control'
}

function dbUrlFor(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl)
  u.pathname = '/' + dbName
  return u.toString()
}

function connect(url: string): ReturnType<typeof postgres> {
  return postgres(url, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} })
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))
}

// ── the leaf's own runner ─────────────────────────────────────────────────────

/**
 * The leaf's store opener IS its runner: manifest hash check of every file, then every file in order. It
 * is called here only for a database that exists, and its pool is ended straight away so the registry
 * never fills and nothing is evicted with a warning.
 */
function leafRunner(openStore: OpenStoreFn): MigrateFn {
  return async (tenant, ctx) => {
    await openStore(tenant, { pgUrl: ctx.pgUrl, dbPrefix: ctx.dbPrefix, _overrideManifest: ctx.manifest })
    await evictTenantPools({ id: tenant.id })
  }
}

// ── one customer ──────────────────────────────────────────────────────────────

type Outcome = { kind: 'migrated' } | { kind: 'skipped' } | { kind: 'failed'; cls: FailureClass }

async function migrateCustomer(
  admin: ReturnType<typeof postgres>,
  row: { id: string; slug: string },
  run: { pgUrl: string; dbPrefix: string; retryDelayMs: number; migrate: MigrateFn; manifest?: Record<string, string> },
): Promise<Outcome> {
  if (!isServableRow(row)) return { kind: 'failed', cls: 'sql' }
  const dbName = run.dbPrefix + row.slug
  let lockConn: ReturnType<typeof postgres> | null = null
  try {
    const present = await admin`SELECT 1 AS present FROM pg_database WHERE datname = ${dbName}`
    if (present.length === 0) return { kind: 'skipped' }

    lockConn = connect(dbUrlFor(run.pgUrl, dbName))
    await lockConn`SELECT pg_advisory_lock(hashtextextended(${MIGRATE_LOCK_NAME}, 0))`

    for (let attempt = 1; ; attempt++) {
      try {
        await run.migrate({ id: row.id, slug: row.slug }, { pgUrl: run.pgUrl, dbPrefix: run.dbPrefix, manifest: run.manifest })
        return { kind: 'migrated' }
      } catch (err) {
        const cls = classifyFailure(err)
        if (cls === 'race' && attempt < MAX_ATTEMPTS) {
          await sleep(run.retryDelayMs)
          continue
        }
        return { kind: 'failed', cls }
      }
    }
  } catch (err) {
    // Only the look, the connect and the lock can throw to here (a failed attempt is returned from the loop
    // above), and nothing has been written yet: a dropped connection is "retry later".
    // The database was dropped between the look and the connect: nothing to migrate, nothing to create.
    if (codeOf(err) === '3D000') return { kind: 'skipped' }
    return { kind: 'failed', cls: classifyFailure(err, 'before-ddl') }
  } finally {
    // The session lock goes with its connection.
    if (lockConn !== null) await lockConn.end({ timeout: 5 }).catch(() => {})
  }
}

// ── the whole run ─────────────────────────────────────────────────────────────

export async function runMigrateOnly(
  deps: MigrateOnlyDeps,
  options: MigrateOnlyOptions = {},
): Promise<MigrateOnlyResult> {
  const counts: MigrateOnlyCounts = { v: 1, total: 0, migrated: 0, skipped: 0, failed: 0 }

  let pgUrl: string
  try {
    pgUrl = requireRuntimePgUrl(options.pgUrl, PG_URL_ENV)
    new URL(pgUrl)
  } catch {
    return { code: 2, counts, reason: 'env' }
  }
  const dbPrefix = options.dbPrefix ?? DEFAULT_DB_PREFIX
  const run = {
    pgUrl,
    dbPrefix,
    retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    migrate: options.migrate ?? leafRunner(deps.openStore),
    manifest: options.manifest,
  }

  let admin: ReturnType<typeof postgres> | null = null
  let control: ReturnType<typeof postgres> | null = null
  try {
    admin = connect(pgUrl)

    // 1. Read the catalogue WITHOUT creating anything.
    const controlName = dbPrefix + 'control'
    const hasControl = await admin`SELECT 1 AS present FROM pg_database WHERE datname = ${controlName}`
    if (hasControl.length === 0) return { code: 0, counts }

    let rows: { id: string; slug: string }[]
    try {
      control = connect(dbUrlFor(pgUrl, controlName))
      const table = await control`SELECT to_regclass('tenant_catalog') IS NOT NULL AS present`
      if (table[0]?.present !== true) return { code: 0, counts }
      rows = await control<{ id: string; slug: string }[]>`
        SELECT tenant_id::text AS id, slug FROM tenant_catalog ORDER BY created_at, tenant_id
      `
    } catch (err) {
      if (codeOf(err) === '3D000') return { code: 0, counts } // dropped between the look and the connect
      throw err
    }
    counts.total = rows.length

    // 2. Every catalogued customer, one after the other, inside this process.
    let sawSql = false
    let sawPrecondition = false
    let sawRetryLater = false
    let unreachable = false
    for (const row of rows) {
      if (unreachable) {
        // The server is gone: do not wait out a connect timeout per remaining customer.
        counts.failed++
        continue
      }
      const outcome = await migrateCustomer(admin, row, run)
      if (outcome.kind === 'migrated') counts.migrated++
      else if (outcome.kind === 'skipped') counts.skipped++
      else {
        counts.failed++
        if (outcome.cls === 'sql') sawSql = true
        else if (outcome.cls === 'precondition') sawPrecondition = true
        else sawRetryLater = true
        if (outcome.cls === 'unreachable') unreachable = true
      }
    }
    if (sawSql) return { code: 1, counts }
    if (sawPrecondition) return { code: 2, counts, reason: 'login' }
    return { code: sawRetryLater ? 3 : 0, counts }
  } catch (err) {
    // The catalogue could not be read at all (before any DDL).
    const cls = classifyFailure(err, 'before-ddl')
    if (cls === 'precondition') return { code: 2, counts, reason: 'login' }
    return { code: cls === 'sql' ? 1 : 3, counts }
  } finally {
    if (control !== null) await control.end({ timeout: 5 }).catch(() => {})
    if (admin !== null) await admin.end({ timeout: 5 }).catch(() => {})
  }
}

// ── the process entry ─────────────────────────────────────────────────────────

function writeLine(line: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(line + '\n', () => resolve())
  })
}

/**
 * `node dist/index.js --migrate-only`. Returns the exit code; index.ts exits with it. The counts line
 * is the only thing on stdout, on exits 0, 1 and 3.
 */
export async function runMigrateOnlyCli(
  deps: MigrateOnlyDeps,
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  if (argv.some((a) => a !== '--migrate-only')) {
    // No slug argument (or any other): the run goes through the customers by itself.
    process.stderr.write(`[${LEAF}] --migrate-only takes no other argument\n`)
    return 2
  }
  // A library notice or a store warning must not add a line, and none may carry a customer name.
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    console[method] = () => {}
  }
  const result = await runMigrateOnly(deps)
  if (result.code === 2) {
    process.stderr.write(
      result.reason === 'login'
        ? `[${LEAF}] --migrate-only: the database refused the login\n`
        : `[${LEAF}] --migrate-only: ${PG_URL_ENV} is not set or not a URL\n`,
    )
    return 2
  }
  await writeLine(JSON.stringify(result.counts))
  return result.code
}
