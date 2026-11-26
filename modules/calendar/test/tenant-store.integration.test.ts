/**
 * Integration tests for modules/calendar/src/tenant-store.ts
 *
 * Runs against CALENDAR_TEST_PG_URL (a local throwaway Postgres instance).
 * Fail-closed guard: refuses to run unless the host is localhost/127.0.0.1
 * AND the catalogue database uses the `calendar_test_` prefix.
 *
 * Coverage:
 *  - storeFor opens t_<hex32>__calendar (the lifecycle database of the tenant), which the test
 *    provisioned the way enableModule does; it returns a pool whose current_database() is that name.
 *  - The leaf makes no database of its own for a customer: no calendar_test_<slug> appears.
 *  - Second call returns the SAME pool instance (identity).
 *  - A second tenant gets a DISTINCT database and a DISTINCT pool.
 *  - catalog rows are present in the control DB after first contact, naming the lifecycle database.
 *  - A tenant whose database does not exist is refused as not provisioned, and nothing is created.
 *  - The leaf never migrates: a database behind the manifest is refused (503 schema_not_current).
 *  - A bad slug is refused before any database is touched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import {
  storeFor,
  _resetTenantStoreForTests,
  type TenantRef,
} from '../src/tenant-store.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'
import { FIXTURE_DB_PATTERN, fixtureDb, fixtureId, provisionLifecycleDbs } from './support/scratch-pg.ts'

// ── fail-closed guard (mirrors #249 / assert-safe-test-db-url pattern) ────────
const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'calendar_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

const OPTS = { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX, moduleUrl: TEST_PG_URL }

// ── test tenants ──────────────────────────────────────────────────────────────
const ALPHA: TenantRef = { id: fixtureId('111111111111'), slug: 'alpha' }
const BETA: TenantRef = { id: fixtureId('222222222222'), slug: 'beta' }
/** Valid, but never provisioned. */
const GAMMA: TenantRef = { id: fixtureId('333333333333'), slug: 'gamma' }
/** Provisioned, then left one migration behind. */
const DELTA: TenantRef = { id: fixtureId('444444444444'), slug: 'delta' }

// ── admin connection (for pg_database queries + cleanup) ──────────────────────
let admin: ReturnType<typeof postgres>

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 1, prepare: false })
  // Clean up any leftover DBs from a previous run so tests are hermetic.
  await dropTestDbs(admin)
  await provisionLifecycleDbs(TEST_PG_URL, [ALPHA.id, BETA.id, DELTA.id])
})

afterAll(async () => {
  // Reset the in-process state and drain all pools.
  await _resetTenantStoreForTests()
  // Drop the test databases.
  await dropTestDbs(admin)
  await admin.end()
})

async function dropTestDbs(sql: ReturnType<typeof postgres>): Promise<void> {
  const rows = await sql<{ datname: string }[]>`
    SELECT datname FROM pg_database
    WHERE datname LIKE 'calendar_test_%' OR datname ~ ${FIXTURE_DB_PATTERN}
  `
  for (const { datname } of rows) {
    // TERMINATE existing connections before DROP DATABASE.
    await sql.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${datname}' AND pid <> pg_backend_pid()`,
    )
    await sql.unsafe(`DROP DATABASE IF EXISTS "${datname}"`)
  }
}

// ── tests ──────────────────────────────────────────────────────────────────────
describe('tenant-store (integration)', () => {
  it('storeFor alpha opens its lifecycle database t_<hex32>__calendar and returns a pool', async () => {
    const pool = await storeFor(ALPHA, OPTS)
    expect(pool).toBeDefined()
    // postgres-js Sql is a tagged-template-literal function — typeof is 'function'.
    expect(typeof pool === 'function' || typeof pool === 'object').toBe(true)
    const [row] = await pool<{ db: string }[]>`SELECT current_database() AS db`
    expect(row!.db).toBe(fixtureDb(ALPHA.id))
    expect(row!.db).toMatch(/^t_[0-9a-f]{32}__calendar$/)
    // The leaf applied nothing itself: the tables are the lifecycle migration's.
    const tables = await pool<{ n: string }[]>`
      SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'calendar_events'
    `
    expect(Number(tables[0]!.n)).toBe(1)
  })

  it('storeFor makes no calendar_<slug> database: the only database the leaf creates is the catalogue one', async () => {
    await storeFor(ALPHA, OPTS)
    await storeFor(BETA, OPTS)
    const rows = await admin<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname LIKE 'calendar_test_%' ORDER BY datname
    `
    expect(rows.map((r) => r.datname)).toEqual(['calendar_test_control'])
  })

  it('storeFor alpha twice returns the SAME pool instance', async () => {
    const p1 = await storeFor(ALPHA, OPTS)
    const p2 = await storeFor(ALPHA, OPTS)
    expect(p1).toBe(p2)
  })

  it('storeFor beta is a DISTINCT database and a DISTINCT pool', async () => {
    const poolAlpha = await storeFor(ALPHA, OPTS)
    const poolBeta = await storeFor(BETA, OPTS)

    expect(poolBeta).not.toBe(poolAlpha)
    const [a] = await poolAlpha<{ db: string }[]>`SELECT current_database() AS db`
    const [b] = await poolBeta<{ db: string }[]>`SELECT current_database() AS db`
    expect(a!.db).toBe(fixtureDb(ALPHA.id))
    expect(b!.db).toBe(fixtureDb(BETA.id))
  })

  it('catalog rows are present in the control DB after first contact, naming the lifecycle database', async () => {
    await storeFor(ALPHA, OPTS)
    await storeFor(BETA, OPTS)

    // Control DB name = dbPrefix + 'control' = 'calendar_test_control'
    const controlUrl = replaceDbName(TEST_PG_URL, 'calendar_test_control')
    const ctrl = postgres(controlUrl, { max: 1, prepare: false })
    try {
      const rows = await ctrl<{ tenant_id: string; slug: string; db_name: string }[]>`
        SELECT tenant_id, slug, db_name FROM tenant_catalog ORDER BY slug
      `
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ tenant_id: ALPHA.id, slug: 'alpha', db_name: fixtureDb(ALPHA.id) })
      expect(rows[1]).toMatchObject({ tenant_id: BETA.id, slug: 'beta', db_name: fixtureDb(BETA.id) })
    } finally {
      await ctrl.end()
    }
  })

  it('a tenant whose lifecycle database does not exist is refused as not provisioned and no database is created', async () => {
    await expect(storeFor(GAMMA, OPTS)).rejects.toMatchObject({ code: 'TENANT_NOT_PROVISIONED' })
    const rows = await admin<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname = ${fixtureDb(GAMMA.id)} OR datname = ${TEST_DB_PREFIX + 'gamma'}
    `
    expect(rows).toHaveLength(0)
  })

  it('the leaf never migrates: a database behind the manifest is refused as schema_not_current and stays behind', async () => {
    // Make DELTA one migration behind: drop the newest ledger row.
    const deltaUrl = replaceDbName(TEST_PG_URL, fixtureDb(DELTA.id))
    const direct = postgres(deltaUrl, { max: 1, prepare: false })
    try {
      await direct`DELETE FROM schema_migrations WHERE filename = '003_holiday_unique.sql'`
    } finally {
      await direct.end()
    }
    await _resetTenantStoreForTests()
    await expect(storeFor(DELTA, OPTS)).rejects.toMatchObject({ code: 'TENANT_UNAVAILABLE', reason: 'schema_not_current' })
    const check = postgres(deltaUrl, { max: 1, prepare: false })
    try {
      const rows = await check<{ filename: string }[]>`SELECT filename FROM schema_migrations WHERE filename = '003_holiday_unique.sql'`
      expect(rows).toHaveLength(0)
    } finally {
      await check.end()
    }
  })

  it('storeFor after a reset opens the database again without error (the leaf has nothing to migrate)', async () => {
    await _resetTenantStoreForTests()
    const pool1 = await storeFor(ALPHA, OPTS)
    await _resetTenantStoreForTests()
    const pool2 = await storeFor(ALPHA, OPTS)
    // They are different instances (the store was reset), but both should succeed.
    expect(pool1).toBeDefined()
    expect(pool2).toBeDefined()
    expect(pool1).not.toBe(pool2)
  })

  it('storeFor rejects an invalid slug and touches no database', async () => {
    // Slugs with double-quotes (identifier injection vector) or other invalid
    // characters must be rejected before anything is bound or opened.
    const badCases: Array<{ id: string; slug: string }> = [
      { id: fixtureId('444444444401'), slug: 'bad"name' },
      { id: fixtureId('444444444402'), slug: 'UPPER' },
      { id: fixtureId('444444444403'), slug: 'has space' },
      { id: fixtureId('444444444404'), slug: '-leading' },
      { id: fixtureId('444444444405'), slug: 'trailing-' },
      { id: fixtureId('444444444406'), slug: 'a'.repeat(31) },
      { id: fixtureId('444444444407'), slug: '' },
    ]
    for (const tenant of badCases) {
      await expect(storeFor(tenant, OPTS)).rejects.toThrow(/invalid tenant slug|slug must match/i)
    }

    // Confirm no DB was made for any of the bad slugs.
    const rows = await admin<{ datname: string }[]>`
      SELECT datname FROM pg_database
      WHERE datname LIKE ${TEST_DB_PREFIX + 'bad%'}
         OR datname LIKE ${TEST_DB_PREFIX + 'UPPER%'}
         OR datname LIKE ${TEST_DB_PREFIX + 'has%'}
         OR datname LIKE ${TEST_DB_PREFIX + '-leading%'}
         OR datname LIKE ${TEST_DB_PREFIX + 'trailing-%'}
    `
    expect(rows).toHaveLength(0)
  })
})

// ── helpers ───────────────────────────────────────────────────────────────────
function replaceDbName(pgUrl: string, newDb: string): string {
  const u = new URL(pgUrl)
  u.pathname = '/' + newDb
  return u.toString()
}
