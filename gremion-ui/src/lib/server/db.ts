import postgres from 'postgres'
import { env } from '$env/dynamic/private'
import { requireTenant } from '$lib/server/tenant/context'
import { getPoolForTenant } from '$lib/server/db/pool-registry'
import type { Sql } from '@gremion/db'
import { readFileSync, readdirSync } from 'fs'
import { createHash } from 'node:crypto'
import { join } from 'path'
import { readConfig } from '$lib/server/config'
import { MODULE_MANIFESTS } from '$lib/modules/registry'
import { backFillNotice } from '$lib/modules/migration-ownership'
import { disabledModuleMigrationFiles, moduleReenableCatchup } from '$lib/server/module-migrations'

// Re-export shared types from @gremion/db so existing imports from '$lib/server/db' continue to work
export type {
  Committee, CalendarEvent, EventRecurrence,
  Protocol, ProtocolAttendance, ProtocolResolution, ProtocolActionItem,
  NewsPost
} from '@gremion/db';

/**
 * The work-scoped SQL pool for the CURRENT tenant. P2.1a: no longer a process-
 * global `let _db` keyed by the bare connection env var. Resolves the canonical
 * tenant from AsyncLocalStorage (requireTenant, fail-closed §1.7 — THROWS on empty store,
 * never defaults to tenant #1) and returns that tenant's pool from the bounded
 * draining LRU registry. Zero-arg signature is UNCHANGED, so all request-scoped
 * getDb() call sites need no edits. Out-of-request callers (boot, cron) MUST run
 * inside runWithTenant(ctx, …) (Task 31 / P2.1b).
 */
export function getDb(): Sql {
  return getPoolForTenant(requireTenant())
}

// SQLSTATE / Node error codes that mean "the database is not accepting queries
// yet" — a transient startup race, not a genuine fault.
const TRANSIENT_DB_STARTUP_CODES = new Set([
  '57P03', // cannot_connect_now — "the database system is starting up"
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '08000', '08001', '08003', '08004', '08006', // connection_exception family
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'CONNECT_TIMEOUT',
])

/**
 * TASK-023 (Q1): thrown by waitForDbReady when its attempt budget runs out.
 *
 * A DISTINCT class, classed NON-transient by isTransientDbStartupError, so boot
 * exits(1) and the orchestrator's restart policy takes over. Before this the
 * exhaustion was a plain Error whose message embedded the last cause
 * ('database not ready after N attempts: connect ECONNREFUSED ...') -- text the
 * transient regex below matches, so an exhausted budget was retried forever.
 * The message deliberately does NOT embed the cause; it rides on `cause`.
 */
export class DbStartupBudgetExhaustedError extends Error {
  readonly attempts: number
  constructor(attempts: number, lastError: unknown) {
    super(`database not ready after ${attempts} attempts (startup budget exhausted)`, { cause: lastError })
    this.name = 'DbStartupBudgetExhaustedError'
    this.attempts = attempts
  }
}

/**
 * True when an error means Postgres is not ready yet (booting / not accepting
 * connections) rather than a real fault. Lets boot retry a transient startup
 * race while still failing fast on a genuine migration or schema bug. An
 * exhausted startup budget is never transient (Q1).
 */
export function isTransientDbStartupError(err: unknown): boolean {
  if (err instanceof DbStartupBudgetExhaustedError) return false
  const code = (err as { code?: unknown } | null | undefined)?.code
  if (typeof code === 'string' && TRANSIENT_DB_STARTUP_CODES.has(code)) return true
  const message =
    err instanceof Error
      ? err.message
      : err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : ''
  return /starting up|the database system is|econnrefused|connection refused|connect_timeout|could not connect|terminating connection due to/i.test(
    message,
  )
}

/** First wait of the startup ladder (ms); each further wait doubles it. */
export const DB_STARTUP_INITIAL_DELAY_MS = 500
/** The ladder's ceiling (ms): no single wait is ever longer. */
export const DB_STARTUP_MAX_DELAY_MS = 30_000
/** Default attempt budget: the first 7 waits take 31-62 s, the other 52 are capped
 *  (15-30 s each), so boot gives up and exits after ~14-27 min. */
export const DB_STARTUP_ATTEMPTS = 60

/**
 * The ladder step before jitter for 1-based `attempt`:
 * min(maxDelayMs, initialDelayMs * 2^(attempt-1)) -> 500, 1000, 2000, ... 30000.
 */
export function dbStartupBackoffMs(
  attempt: number,
  opts: { initialDelayMs?: number; maxDelayMs?: number } = {},
): number {
  const initial = opts.initialDelayMs ?? DB_STARTUP_INITIAL_DELAY_MS
  const max = opts.maxDelayMs ?? DB_STARTUP_MAX_DELAY_MS
  return Math.min(max, initial * 2 ** Math.max(0, attempt - 1))
}

/** Jitter a ladder step into the window [50%, 100%] of it (`random` in [0, 1)). */
export function jitterDelayMs(stepMs: number, random: () => number = Math.random): number {
  const r = Math.min(Math.max(random(), 0), 1)
  return Math.round(stepMs / 2 + (stepMs / 2) * r)
}

export interface WaitForDbReadyOptions {
  /** Max ping attempts before giving up (default DB_STARTUP_ATTEMPTS). */
  attempts?: number
  /** First ladder step in ms (default DB_STARTUP_INITIAL_DELAY_MS). */
  initialDelayMs?: number
  /** Ladder ceiling in ms (default DB_STARTUP_MAX_DELAY_MS). */
  maxDelayMs?: number
  /** Injectable readiness probe — defaults to `SELECT 1` on the pool. */
  ping?: () => Promise<unknown>
  /** Injectable sleep — defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable jitter source in [0, 1) — defaults to Math.random. */
  random?: () => number
}

/**
 * Block until Postgres accepts a trivial query, retrying transient startup
 * errors (see isTransientDbStartupError) on an exponential ladder with jitter:
 * the n-th wait is jitterDelayMs(dbStartupBackoffMs(n)), i.e. 500 ms doubling,
 * never above maxDelayMs (30 s), each jittered into [50%, 100%]. Every wait is
 * logged with its attempt, ladder step and whether the cap applied. A
 * non-transient error (bad credentials, a real schema fault) is rethrown
 * immediately; an exhausted budget throws DbStartupBudgetExhaustedError, which
 * is itself non-transient (Q1).
 *
 * Makes boot survive a reboot race where the Docker daemon starts gremion-ui
 * before Postgres is ready (depends_on only orders `compose up`, not a daemon
 * restart) instead of latching a permanent unhealthy state.
 */
export async function waitForDbReady(options: WaitForDbReadyOptions = {}): Promise<void> {
  const attempts = options.attempts ?? DB_STARTUP_ATTEMPTS
  const ladder = { initialDelayMs: options.initialDelayMs, maxDelayMs: options.maxDelayMs }
  const maxDelayMs = options.maxDelayMs ?? DB_STARTUP_MAX_DELAY_MS
  const ping = options.ping ?? (() => getDb()`SELECT 1`)
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = options.random ?? Math.random

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await ping()
      return
    } catch (err) {
      if (!isTransientDbStartupError(err)) throw err
      lastError = err
      if (attempt < attempts) {
        const step = dbStartupBackoffMs(attempt, ladder)
        const wait = jitterDelayMs(step, random)
        console.warn(
          `[boot] database not ready (attempt ${attempt}/${attempts}): ${(err as Error)?.message ?? String(err)}; ` +
            `backoff=${step}ms${step >= maxDelayMs ? ' (capped)' : ''} wait=${wait}ms`,
        )
        await sleep(wait)
      }
    }
  }
  throw new DbStartupBudgetExhaustedError(attempts, lastError)
}

/**
 * G-012: verify a migration file's bytes against the build-time SHA-256
 * manifest before `sql.unsafe(text)` is allowed to execute it. Pure helper
 * exported so unit tests can exercise the verification logic directly
 * without standing up Postgres.
 *
 * Throws on any of:
 *   - filename has no entry in the manifest ("missing from manifest")
 *   - on-disk text hashes differently than the manifest entry ("tampered")
 */
export function verifyMigrationIntegrity(
  filename: string,
  text: string,
  manifest: Record<string, string>,
): void {
  const expected = manifest[filename]
  if (!expected) {
    throw new Error(`Migration ${filename} missing from manifest`)
  }
  const actual = createHash('sha256').update(text).digest('hex')
  if (actual !== expected) {
    throw new Error(
      `Migration ${filename} tampered: expected ${expected.slice(0, 8)}…, got ${actual.slice(0, 8)}…`,
    )
  }
}

/** Loads migrations/manifest.json from disk. Throws if missing or malformed. */
export function loadMigrationManifest(dir: string): Record<string, string> {
  const raw = readFileSync(join(dir, 'manifest.json'), 'utf-8')
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('migrations/manifest.json is not an object')
  }
  return parsed as Record<string, string>
}

/** Runs all pending migrations from gremion-ui/migrations/ in filename order. */
export async function runMigrations(): Promise<void> {
  const sql = getDb()

  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `

  // P0.2: capture fresh-DB state BEFORE applying anything, and the applied set,
  // so the module-aware gating can (a) skip disabled-module migrations on a
  // fresh init and (b) plan an OFF→ON re-enable catch-up on an initialized DB.
  // The single upfront SELECT also replaces the old per-file existence round-trip.
  const appliedRows = await sql<{ filename: string }[]>`SELECT filename FROM schema_migrations`
  const applied = new Set(appliedRows.map((r) => r.filename))
  const isFreshDb = applied.size === 0

  // readConfig() is file-based (CONFIG_PATH JSON, Zod-validated, no DB), so it
  // is safe to read here before/while migrations run.
  const config = readConfig()
  // P3 #203 WP5: an OFF→ON re-enable on an already-initialized tenant is now a
  // supported catch-up (no longer refused). moduleReenableCatchup is a PURE
  // planner — it never throws; the unapplied files it reports are picked up by
  // the standard apply loop below (they are absent from `applied` and, the
  // module being ON, absent from moduleSkips). Log the plan for observability.
  const catchUpFiles = new Set<string>()
  for (const plan of moduleReenableCatchup({ isFreshDb, applied, config, manifests: MODULE_MANIFESTS })) {
    for (const f of plan.files) catchUpFiles.add(f)
    console.info(
      `[migrations] module '${plan.moduleId}' OFF→ON re-enable catch-up: ${plan.files.join(', ')}`,
    )
  }
  const moduleSkips = disabledModuleMigrationFiles(config, MODULE_MANIFESTS)

  const dir = join(process.cwd(), 'migrations')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  // G-012: load the SHA-256 manifest once per runMigrations() invocation.
  // Each *.sql file's bytes are verified against this manifest before
  // sql.unsafe() is allowed to execute the contents — so a swapped or
  // tampered migration aborts the boot rather than silently running.
  const manifest = loadMigrationManifest(dir)
  // TASK-029 G5 (TRD-353): verify EVERY file -- applied, seed-skipped and
  // module-skipped ones included -- before the applied-skip below and before
  // any file runs. Checking only the file about to be applied let a tampered
  // manifest entry or a swapped file for an ALREADY-applied migration boot
  // clean. The ledger-hash half (applied row sha256 = manifest) needs the
  // sha256 ledger column and is the owner-of-the-tenant-store-move's residual.
  const texts = new Map<string, string>()
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf-8')
    verifyMigrationIntegrity(file, text, manifest)
    texts.set(file, text)
  }

  const skipSeeds = env.GREMION_DISABLE_SEEDS === 'true'

  // A file numbered into a gap BELOW this database's high-water mark is a
  // back-fill, not a forward migration: the apply loop picks it up out of
  // order and a reference to a since-renamed table aborts the boot with an
  // error that names the table instead of the cause. Say the cause first.
  const backFill = backFillNotice({
    applied,
    candidates: files.filter(
      (f) => !(skipSeeds && f.endsWith('_seed.sql')) && !moduleSkips.has(f),
    ),
    expected: catchUpFiles,
  })
  if (backFill) console.warn(backFill)

  for (const file of files) {
    // Dev seed files (*_seed.sql) populate test committees and members keyed
    // by Keycloak UUIDs that only exist in the dev realm. GREMION_DISABLE_SEEDS
    // (set in docker-compose.prod.yml) keeps them out of production, where
    // those UUIDs 404 against Keycloak and render as raw IDs.
    if (skipSeeds && file.endsWith('_seed.sql')) {
      console.info(`[migrations] skipped seed ${file} (GREMION_DISABLE_SEEDS)`)
      continue
    }
    // P0.2: a disabled toggleable module's migrations are skipped and recorded
    // nowhere — a fresh finance-OFF vertical never creates the finance schema.
    if (moduleSkips.has(file)) {
      console.info(`[migrations] skipped ${file} (module disabled)`)
      continue
    }
    if (applied.has(file)) continue

    // G-012: every file was verified above, BEFORE any sql.unsafe().
    const sql_text = texts.get(file) as string
    await applyMigrationFile(sql, file, sql_text)
    console.info(`[migrations] applied ${file}`)
  }
}

/**
 * G-078: apply a single migration file atomically.
 *
 * The previous shape ran `sql.unsafe(sql_text)` and the schema_migrations
 * bookkeeping INSERT as two independent statements. A crash between them
 * (process kill, OOM, network blip) left the migration successfully
 * applied but unrecorded — the next boot would re-run a non-idempotent
 * migration and explode on the first duplicate-table / duplicate-column.
 *
 * Wrapping both calls in a single postgres-js `sql.begin` transaction
 * makes the pair atomic: either the schema change AND the bookkeeping
 * row both land, or neither does and the next boot retries cleanly.
 *
 * Extracted as a named export so the unit test can inject a deliberately-
 * failing SQL body and assert no bookkeeping row leaks out.
 */
export async function applyMigrationFile(
  sql: ReturnType<typeof postgres>,
  filename: string,
  sql_text: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(sql_text)
    await tx`INSERT INTO schema_migrations (filename) VALUES (${filename})`
  })
}
