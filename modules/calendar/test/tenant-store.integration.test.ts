/**
 * Integration tests for services/calendar/src/tenant-store.ts
 *
 * Runs against CALENDAR_TEST_PG_URL (a local throwaway Postgres instance).
 * Fail-closed guard: refuses to run unless the host is localhost/127.0.0.1
 * AND all test DBs use the `calendar_test_` prefix.
 *
 * Coverage (brief TDD checklist):
 *  - storeFor({id,slug:'alpha'}) creates `calendar_test_alpha`, applies 001,
 *    returns a pool.
 *  - Second call returns the SAME pool instance (identity).
 *  - A second tenant gets a DISTINCT db and a DISTINCT pool.
 *  - catalog rows are present in the control DB after ensure.
 *  - Migration manifest hash mismatch aborts (does not corrupt the DB).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import {
  storeFor,
  _resetTenantStoreForTests,
  type TenantRef,
} from '../src/tenant-store.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

// ── fail-closed guard (mirrors #249 / assert-safe-test-db-url pattern) ────────
const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'calendar_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

// ── test tenants ──────────────────────────────────────────────────────────────
const ALPHA: TenantRef = { id: '11111111-1111-1111-1111-111111111111', slug: 'alpha' }
const BETA: TenantRef = { id: '22222222-2222-2222-2222-222222222222', slug: 'beta' }

// ── admin connection (for pg_database queries + cleanup) ──────────────────────
let admin: ReturnType<typeof postgres>

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 1, prepare: false })
  // Clean up any leftover DBs from a previous run so tests are hermetic.
  await dropTestDbs(admin)
})

afterAll(async () => {
  // Reset the in-process pool registry and drain all pools.
  await _resetTenantStoreForTests()
  // Drop the test databases.
  await dropTestDbs(admin)
  await admin.end()
})

async function dropTestDbs(sql: ReturnType<typeof postgres>): Promise<void> {
  const rows = await sql<{ datname: string }[]>`
    SELECT datname FROM pg_database
    WHERE datname LIKE 'calendar_test_%'
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
  it('storeFor alpha creates calendar_test_alpha and returns a pool', async () => {
    const pool = await storeFor(ALPHA, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    expect(pool).toBeDefined()
    // postgres-js Sql is a tagged-template-literal function — typeof is 'function'.
    expect(typeof pool === 'function' || typeof pool === 'object').toBe(true)

    // Confirm the DB was created.
    const rows = await admin<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname = 'calendar_test_alpha'
    `
    expect(rows).toHaveLength(1)
  })

  it('storeFor alpha twice returns the SAME pool instance', async () => {
    const p1 = await storeFor(ALPHA, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    const p2 = await storeFor(ALPHA, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    expect(p1).toBe(p2)
  })

  it('storeFor beta creates a DISTINCT db and a DISTINCT pool', async () => {
    const poolAlpha = await storeFor(ALPHA, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    const poolBeta = await storeFor(BETA, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })

    expect(poolBeta).not.toBe(poolAlpha)

    const rows = await admin<{ datname: string }[]>`
      SELECT datname FROM pg_database
      WHERE datname IN ('calendar_test_alpha', 'calendar_test_beta')
      ORDER BY datname
    `
    expect(rows.map((r) => r.datname)).toEqual(['calendar_test_alpha', 'calendar_test_beta'])
  })

  it('catalog rows are present in the control DB after ensure', async () => {
    // Both alpha and beta should be catalogued.
    await storeFor(ALPHA, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    await storeFor(BETA, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })

    // Connect to the control DB to check.
    // Control DB name = dbPrefix + 'control' = 'calendar_test_control'
    const controlUrl = replaceDbName(TEST_PG_URL, 'calendar_test_control')
    const ctrl = postgres(controlUrl, { max: 1, prepare: false })
    try {
      const rows = await ctrl<{ tenant_id: string; slug: string; db_name: string }[]>`
        SELECT tenant_id, slug, db_name FROM tenant_catalog ORDER BY slug
      `
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ tenant_id: ALPHA.id, slug: 'alpha', db_name: 'calendar_test_alpha' })
      expect(rows[1]).toMatchObject({ tenant_id: BETA.id, slug: 'beta', db_name: 'calendar_test_beta' })
    } finally {
      await ctrl.end()
    }
  })

  it('migration manifest hash mismatch aborts', async () => {
    // We test this by passing a deliberately wrong manifest entry.
    await expect(
      storeFor(
        { id: '33333333-3333-3333-3333-333333333333', slug: 'gamma' },
        {
          pgUrl: TEST_PG_URL,
          dbPrefix: TEST_DB_PREFIX,
          _overrideManifest: { '001_init.sql': 'deadbeef' },
        },
      ),
    ).rejects.toThrow(/manifest.*mismatch|hash.*mismatch|001_init\.sql/i)
  })

  it('migration is idempotent — calling storeFor twice does not throw', async () => {
    // After _resetTenantStoreForTests, the pool is gone but the DB and tables persist.
    // A second storeFor must not fail even though the tables already exist.
    await _resetTenantStoreForTests()
    const pool1 = await storeFor(ALPHA, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    await _resetTenantStoreForTests()
    const pool2 = await storeFor(ALPHA, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    // They are different instances (registry was reset), but both should succeed.
    expect(pool1).toBeDefined()
    expect(pool2).toBeDefined()
    expect(pool1).not.toBe(pool2)
  })

  it('pg_database shows both test DBs at the end', async () => {
    // Re-ensure both tenants (may have been evicted in the idempotency test above).
    await storeFor(ALPHA, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    await storeFor(BETA, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })

    const rows = await admin<{ datname: string }[]>`
      SELECT datname FROM pg_database
      WHERE datname LIKE 'calendar_test_%'
      ORDER BY datname
    `
    const names = rows.map((r) => r.datname)
    expect(names).toContain('calendar_test_alpha')
    expect(names).toContain('calendar_test_beta')
    console.info('[acceptance] pg_database test DBs:', names.join(', '))
  })

  it('storeFor rejects an invalid slug and creates NO database', async () => {
    // Slugs with double-quotes (identifier injection vector) or other invalid
    // characters must be rejected before any DB name is constructed.
    // Each bad slug gets a unique tenant id so no pool-cache hit can mask the error.
    const badCases: Array<{ id: string; slug: string }> = [
      { id: '44444444-4444-4444-4444-444444444401', slug: 'bad"name' },
      { id: '44444444-4444-4444-4444-444444444402', slug: 'UPPER' },
      { id: '44444444-4444-4444-4444-444444444403', slug: 'has space' },
      { id: '44444444-4444-4444-4444-444444444404', slug: '-leading' },
      { id: '44444444-4444-4444-4444-444444444405', slug: 'trailing-' },
      { id: '44444444-4444-4444-4444-444444444406', slug: 'a'.repeat(31) },
      { id: '44444444-4444-4444-4444-444444444407', slug: '' },
    ]
    for (const tenant of badCases) {
      await expect(
        storeFor(tenant, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX }),
      ).rejects.toThrow(/invalid tenant slug|slug must match/i)
    }

    // Confirm no DB was created for any of the bad slugs.
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
