// modules/calendar/test/support/scratch-pg.ts
//
// The calendar integration suites' ONE place that creates a customer's lifecycle database on the scratch
// Postgres (CALENDAR_TEST_PG_URL, fail-closed through pg-test-guard.ts). The leaf never creates or
// migrates t_<hex32>__calendar (enableModule does), so a suite that needs one provisions it here the way
// the lifecycle would: CREATE DATABASE, then the ONE runner (@gremion/tenant-store runMigrations — the
// runner enableModule uses) over the module's migrations. It is a destructive scratch-server helper, not a
// tenant connection: it only ever names databases of the FIXTURE tenants (ids under FIXTURE_ID_PREFIX).
// Allow-listed in packages/tenant-store/scripts/tenant-db-access.allow.json.
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { runMigrations, tenantModuleDbName } from '@gremion/tenant-store'

/** The calendar module's migrations (manifest.json + *.sql), from the source tree. */
export const CALENDAR_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url))

/** Every fixture tenant id of the calendar suites starts with this (a canonical UUIDv7). */
export const FIXTURE_ID_PREFIX = '01920000-0000-7000-8000-'

/** A fixture tenant id: the prefix and 12 lowercase hex digits. */
export function fixtureId(last12: string): string {
  if (!/^[0-9a-f]{12}$/.test(last12)) throw new Error(`[scratch-pg] fixtureId wants 12 lowercase hex digits, got ${JSON.stringify(last12)}`)
  return FIXTURE_ID_PREFIX + last12
}

/** SQL regex of the lifecycle databases of fixture tenants (what a suite's cleanup may drop). */
export const FIXTURE_DB_PATTERN = '^t_0192000000007000[0-9a-f]{16}__calendar$'

/** t_<hex32>__calendar of a FIXTURE tenant (refuses any other id). */
export function fixtureDb(tenantId: string): string {
  if (!tenantId.startsWith(FIXTURE_ID_PREFIX)) throw new Error('[scratch-pg] refusing a tenant id that is not a fixture id')
  return tenantModuleDbName(tenantId, 'calendar')
}

function urlFor(serverUrl: string, db: string): string {
  const u = new URL(serverUrl)
  u.pathname = '/' + db
  return u.toString()
}

/** The phases of the calendar chain's files (scripts/migrations/runner/expand-contract-baseline.json). */
const phaseFor = (file: string): { phase: 'expand' } | { phase: 'contract'; contractAfter: string } =>
  file === '003_holiday_unique.sql' ? { phase: 'contract', contractAfter: 'dist-v0.0.1' } : { phase: 'expand' }

/**
 * (Re)create the lifecycle database of a fixture tenant, empty, and migrate it with the one runner.
 * `serverUrl` is the scratch server (superuser, maintenance database).
 */
export async function provisionLifecycleDb(serverUrl: string, tenantId: string): Promise<string> {
  const db = fixtureDb(tenantId)
  const admin = postgres(serverUrl, { max: 1, prepare: false, onnotice: () => {} })
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`)
    await admin.unsafe(`CREATE DATABASE "${db}"`)
  } finally {
    await admin.end({ timeout: 5 })
  }
  const sql = postgres(urlFor(serverUrl, db), { max: 2, prepare: false, onnotice: () => {} })
  try {
    await runMigrations({ sql, dir: CALENDAR_MIGRATIONS_DIR, releaseRef: 'dist-v0.0.1', phaseFor, log: () => {} })
  } finally {
    await sql.end({ timeout: 5 })
  }
  return db
}

/** Provision several fixture tenants, one after the other. */
export async function provisionLifecycleDbs(serverUrl: string, tenantIds: readonly string[]): Promise<void> {
  for (const id of tenantIds) await provisionLifecycleDb(serverUrl, id)
}
