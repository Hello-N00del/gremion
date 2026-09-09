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
 * True when an error means Postgres is not ready yet (booting / not accepting
 * connections) rather than a real fault. Lets boot retry a transient startup
 * race while still failing fast on a genuine migration or schema bug.
 */
export function isTransientDbStartupError(err: unknown): boolean {
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

export interface WaitForDbReadyOptions {
  /** Max ping attempts before giving up (default 60 ≈ 120s at 2s/attempt). */
  attempts?: number
  /** Delay between attempts in ms (default 2000). */
  delayMs?: number
  /** Injectable readiness probe — defaults to `SELECT 1` on the pool. */
  ping?: () => Promise<unknown>
  /** Injectable sleep — defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Block until Postgres accepts a trivial query, retrying transient startup
 * errors (see isTransientDbStartupError) within a bounded budget. A non-transient
 * error (bad credentials, a real schema fault) is rethrown immediately so genuine
 * misconfiguration still fails fast; the budget being exhausted also throws.
 *
 * Makes boot survive a reboot race where the Docker daemon starts gremion-ui
 * before Postgres is ready (depends_on only orders `compose up`, not a daemon
 * restart) instead of latching a permanent unhealthy state.
 */
export async function waitForDbReady(options: WaitForDbReadyOptions = {}): Promise<void> {
  const attempts = options.attempts ?? 60
  const delayMs = options.delayMs ?? 2000
  const ping = options.ping ?? (() => getDb()`SELECT 1`)
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await ping()
      return
    } catch (err) {
      if (!isTransientDbStartupError(err)) throw err
      lastError = err
      if (attempt < attempts) {
        console.warn(
          `[boot] database not ready (attempt ${attempt}/${attempts}): ${(err as Error)?.message ?? String(err)}`,
        )
        await sleep(delayMs)
      }
    }
  }
  throw new Error(
    `database not ready after ${attempts} attempts: ${(lastError as Error)?.message ?? String(lastError)}`,
  )
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
  for (const plan of moduleReenableCatchup({ isFreshDb, applied, config, manifests: MODULE_MANIFESTS })) {
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

  const skipSeeds = env.GREMION_DISABLE_SEEDS === 'true'

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

    const sql_text = readFileSync(join(dir, file), 'utf-8')
    // G-012: verify hash BEFORE handing the text to sql.unsafe().
    verifyMigrationIntegrity(file, sql_text, manifest)
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
