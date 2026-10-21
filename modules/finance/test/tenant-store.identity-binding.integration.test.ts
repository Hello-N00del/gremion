/**
 * Integration tests for the (tenant id, slug) binding of src/tenant-store.ts
 * storeFor (audit #534), against a real Postgres.
 *
 * Runs against FINANCE_TEST_PG_URL (a local throwaway Postgres instance).
 * Fail-closed guard: refuses to run unless the host is localhost/127.0.0.1, the
 * port is not 5432, and every test DB uses the `finance_test_` prefix.
 *
 * The database name is derived from the slug alone. Before the binding, a slug
 * that differed from the one an id was catalogued under silently created and
 * opened a new, EMPTY database and rewrote the catalog row, orphaning the
 * tenant's data; a slug the catalog held for another id failed with a bare
 * unique-violation after migrating that other tenant's database. Now:
 *  - a pair the catalog does not hold is refused (TENANT_IDENTITY_MISMATCH),
 *    warm and cold, before any database is created or catalog row written;
 *  - two first contacts racing for one slug under different ids leave exactly one
 *    winner; the loser is refused before it creates anything.
 *
 * No second driver connection: the catalog and pg_database are read through the
 * leaf's own control-DB pool (the same handle storeFor uses). Every database and
 * catalog row this file makes is named bind-*, and only those are ever dropped.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  storeFor,
  listTenants,
  _poolRegistryForTests,
  _resetTenantStoreForTests,
  type TenantRef,
} from '../src/tenant-store.ts'

// ── fail-closed guard (same rules as the sibling finance integration suites) ──
const TEST_DB_PREFIX = 'finance_test_'
const TEST_PG_URL = (() => {
  const url = process.env.FINANCE_TEST_PG_URL
  if (!url) {
    throw new Error(
      '[fin-test-guard] FINANCE_TEST_PG_URL is REQUIRED -- refusing to default to localhost:5432 ' +
        '(the LIVE staging Postgres). Start a throwaway container on a NON-5432 port.',
    )
  }
  const parsed = new URL(url)
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!new Set(['localhost', '127.0.0.1', '::1']).has(host)) {
    throw new Error(`[fin-test-guard] SAFETY VIOLATION: non-localhost host "${host}" -- refusing.`)
  }
  if (parsed.port === '' || parsed.port === '5432') {
    throw new Error('[fin-test-guard] SAFETY VIOLATION: port 5432 (or implicit default) -- refusing.')
  }
  return url
})()

const OPTS = { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX }
const A: TenantRef = { id: 'a1000000-0000-4000-8000-0000000000a1', slug: 'bind-a' }
const B: TenantRef = { id: 'b1000000-0000-4000-8000-0000000000b1', slug: 'bind-b' }
const C: TenantRef = { id: 'c1000000-0000-4000-8000-0000000000c1', slug: 'bind-c' }
const MISMATCH = { code: 'TENANT_IDENTITY_MISMATCH' }

/** The leaf's own control-DB pool: the catalog lives there, and pg_database is global. */
const control = () => _poolRegistryForTests.ensureControl(TEST_PG_URL, TEST_DB_PREFIX)

/** Drop every database and catalog row this file made (bind-*), nothing else. */
async function wipe(): Promise<void> {
  await _resetTenantStoreForTests()
  const ctrl = await control()
  const rows = await ctrl<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE starts_with(datname, ${TEST_DB_PREFIX + 'bind-'})
  `
  for (const { datname } of rows) await ctrl.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`)
  await ctrl`DELETE FROM tenant_catalog WHERE starts_with(slug, 'bind-')`
  await _resetTenantStoreForTests()
}

async function databases(): Promise<string[]> {
  const ctrl = await control()
  const rows = await ctrl<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE starts_with(datname, ${TEST_DB_PREFIX + 'bind-'}) ORDER BY datname
  `
  return rows.map((r) => r.datname)
}

async function catalog(): Promise<{ tenant_id: string; slug: string; db_name: string }[]> {
  const ctrl = await control()
  return [
    ...(await ctrl<{ tenant_id: string; slug: string; db_name: string }[]>`
      SELECT tenant_id::text AS tenant_id, slug, db_name FROM tenant_catalog
      WHERE starts_with(slug, 'bind-') ORDER BY slug`),
  ]
}

beforeAll(wipe)
beforeEach(wipe)
afterAll(wipe)

describe('storeFor binds (id, slug) to the catalog (audit #534)', () => {
  it('a slug rename is refused on a cold miss: the tenant keeps its database and data, no empty database appears', async () => {
    const pool = await storeFor(A, OPTS)
    await pool`CREATE TABLE binding_marker (v text)`
    await pool`INSERT INTO binding_marker (v) VALUES ('kept')`
    await _resetTenantStoreForTests() // a leaf restart: the registry is empty

    const dbsBefore = await databases()
    const catalogBefore = await catalog()
    await expect(storeFor({ id: A.id, slug: 'bind-a-renamed' }, OPTS)).rejects.toMatchObject(MISMATCH)

    expect(await databases()).toEqual(dbsBefore)
    expect(await databases()).not.toContain(TEST_DB_PREFIX + 'bind-a-renamed')
    expect(await catalog()).toEqual(catalogBefore)
    expect(catalogBefore).toEqual([{ tenant_id: A.id, slug: A.slug, db_name: TEST_DB_PREFIX + A.slug }])

    // the true pair is still served, with its data
    const again = await storeFor(A, OPTS)
    expect(await again`SELECT v FROM binding_marker`).toEqual([{ v: 'kept' }])
  })

  it('a slug rename is refused on a warm pool, and the true pair still gets the same pool', async () => {
    const pool = await storeFor(A, OPTS)
    const dbsBefore = await databases()
    const catalogBefore = await catalog()
    await expect(storeFor({ id: A.id, slug: 'bind-a-renamed' }, OPTS)).rejects.toMatchObject(MISMATCH)
    expect(await databases()).toEqual(dbsBefore)
    expect(await catalog()).toEqual(catalogBefore)
    expect(await storeFor(A, OPTS)).toBe(pool)
  })

  it("another tenant's slug is refused warm and cold, for a catalogued id and for an unknown id", async () => {
    await storeFor(A, OPTS)
    await storeFor(B, OPTS)
    const dbsBefore = await databases()
    const catalogBefore = await catalog()

    // WARM: both pools are open
    await expect(storeFor({ id: A.id, slug: B.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    await expect(storeFor({ id: C.id, slug: B.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    expect(await catalog()).toEqual(catalogBefore)
    expect(await databases()).toEqual(dbsBefore)

    // COLD: registry empty (a leaf restart)
    await _resetTenantStoreForTests()
    await expect(storeFor({ id: A.id, slug: B.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    await expect(storeFor({ id: C.id, slug: B.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    await expect(storeFor({ id: A.id, slug: 'bind-unused' }, OPTS)).rejects.toMatchObject(MISMATCH)
    expect(await catalog()).toEqual(catalogBefore)
    expect(await databases()).toEqual(dbsBefore)

    // the true pairs are still served, cold
    await expect(storeFor(A, OPTS)).resolves.toBeDefined()
    await expect(storeFor(B, OPTS)).resolves.toBeDefined()
  })

  it('a catalogued pair survives a restart: same single row, same created_at', async () => {
    await storeFor(A, OPTS)
    const ctrl = await control()
    const [first] = await ctrl<{ created_at: Date }[]>`SELECT created_at FROM tenant_catalog WHERE tenant_id = ${A.id}`
    await _resetTenantStoreForTests()
    await storeFor(A, OPTS)
    const after = await (await control())<{ created_at: Date }[]>`
      SELECT created_at FROM tenant_catalog WHERE starts_with(slug, 'bind-')`
    expect(after).toHaveLength(1)
    expect(after[0]!.created_at).toEqual(first!.created_at)
    expect(await listTenants(OPTS)).toContainEqual({ id: A.id, slug: A.slug })
  })

  it('two first contacts for ONE slug under different ids: exactly one wins, the other is refused, one database', async () => {
    const results = await Promise.allSettled([
      storeFor({ id: A.id, slug: 'bind-race' }, OPTS),
      storeFor({ id: B.id, slug: 'bind-race' }, OPTS),
    ])
    const won = results.filter((r) => r.status === 'fulfilled')
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(lost[0]!.reason).toMatchObject(MISMATCH)

    const rows = await catalog()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.slug).toBe('bind-race')
    expect(await databases()).toEqual([TEST_DB_PREFIX + 'bind-race'])
  })

  it('two first contacts for ONE id under different slugs: exactly one catalog row and one database, the loser refused', async () => {
    const slugs = ['bind-race-a', 'bind-race-b']
    const results = await Promise.allSettled(slugs.map((slug) => storeFor({ id: A.id, slug }, OPTS)))
    const won = results.flatMap((r, i) => (r.status === 'fulfilled' ? [i] : []))
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(lost[0]!.reason).toMatchObject(MISMATCH)

    const winner = slugs[won[0]!]!
    expect(await catalog()).toEqual([{ tenant_id: A.id, slug: winner, db_name: TEST_DB_PREFIX + winner }])
    expect(await databases()).toEqual([TEST_DB_PREFIX + winner])
    // the winner's pair is the one served from now on, warm and cold
    await expect(storeFor({ id: A.id, slug: slugs[1 - won[0]!]! }, OPTS)).rejects.toMatchObject(MISMATCH)
    await _resetTenantStoreForTests()
    await expect(storeFor({ id: A.id, slug: winner }, OPTS)).resolves.toBeDefined()
  })

  it('a burst of first contacts for one id under many slugs still leaves one row and one database', async () => {
    const slugs = Array.from({ length: 6 }, (_, i) => `bind-burst-${i}`)
    const results = await Promise.allSettled(slugs.map((slug) => storeFor({ id: C.id, slug }, OPTS)))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(refused).toHaveLength(slugs.length - 1)
    for (const r of refused) expect(r.reason).toMatchObject(MISMATCH)
    expect(await catalog()).toHaveLength(1)
    expect(await databases()).toHaveLength(1)
  })
})
