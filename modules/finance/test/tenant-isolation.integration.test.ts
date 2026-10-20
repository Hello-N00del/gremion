/**
 * Cross-tenant data isolation for the finance leaf (TRD-060 / TRD-061, audit
 * #534), against a real Postgres.
 *
 * Runs against FINANCE_TEST_PG_URL (a local throwaway Postgres instance).
 * Fail-closed guard: refuses to run unless the host is localhost/127.0.0.1, the
 * port is not 5432, and every test DB uses the `finance_test_` prefix.
 *
 * Two tenants, A and B, are served by the leaf's own storeFor(). Rows written
 * through A's store (fiscal years, sub-organisation types) must not be readable,
 * listable, updatable or deletable through B's store, and B's ids must not address A's rows (and the reverse).
 * The (id, slug) binding is checked too: B's id with A's slug, and A's id with
 * B's slug, are refused rather than served A's database.
 *
 * Every database and catalog row this file makes is named iso-*, and only those
 * are ever dropped.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  storeFor,
  _poolRegistryForTests,
  _resetTenantStoreForTests,
  type TenantRef,
} from '../src/tenant-store.ts'
import {
  createFiscalYear,
  listFiscalYears,
  updateFiscalYear,
  createSubOrgType,
  deleteSubOrgType,
  type FiscalYearDto,
  type SubOrgTypeDto,
} from '../src/store/index.ts'

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
const A: TenantRef = { id: 'a2000000-0000-4000-8000-0000000000a2', slug: 'iso-a' }
const B: TenantRef = { id: 'b2000000-0000-4000-8000-0000000000b2', slug: 'iso-b' }
const MISMATCH = { code: 'TENANT_IDENTITY_MISMATCH' }

type Store = Awaited<ReturnType<typeof storeFor>>

/** The leaf's own control-DB pool: the catalog lives there, and pg_database is global. */
const control = () => _poolRegistryForTests.ensureControl(TEST_PG_URL, TEST_DB_PREFIX)

/** Drop every database and catalog row this file made (iso-*), nothing else. */
async function wipe(): Promise<void> {
  await _resetTenantStoreForTests()
  const ctrl = await control()
  const rows = await ctrl<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE starts_with(datname, ${TEST_DB_PREFIX + 'iso-'})
  `
  for (const { datname } of rows) await ctrl.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`)
  await ctrl`DELETE FROM tenant_catalog WHERE starts_with(slug, 'iso-')`
  await _resetTenantStoreForTests()
}

// Ids are per-database serials: A holds 1 and 2, B holds 1. Every cross-tenant
// attempt uses A's id 2, which B does not hold, so a miss cannot be mistaken for
// B legitimately addressing its own row 1.
let sqlA: Store
let sqlB: Store
let aFy1: FiscalYearDto
let aFy2: FiscalYearDto
let bFy: FiscalYearDto
let aType1: SubOrgTypeDto
let aType2: SubOrgTypeDto
let bType: SubOrgTypeDto

const fy = (name: string, year: number) => ({ name, startDate: `${year}-01-01`, endDate: `${year}-12-31` })

const typeNames = async (sql: Store): Promise<string[]> => {
  const rows = await sql<{ name: string }[]>`SELECT name FROM finance.sub_org_type ORDER BY id`
  return rows.map((r) => r.name)
}

beforeAll(async () => {
  await wipe()
  sqlA = await storeFor(A, OPTS)
  sqlB = await storeFor(B, OPTS)
  aFy1 = await createFiscalYear(sqlA, fy('canary-a-fy-1', 2030))
  aFy2 = await createFiscalYear(sqlA, fy('canary-a-fy-2', 2031))
  bFy = await createFiscalYear(sqlB, fy('canary-b-fy-1', 2040))
  aType1 = await createSubOrgType(sqlA, { name: 'canary-a-type-1' })
  aType2 = await createSubOrgType(sqlA, { name: 'canary-a-type-2' })
  bType = await createSubOrgType(sqlB, { name: 'canary-b-type-1' })
}, 60_000)

afterAll(wipe, 60_000)

describe('finance leaf: two-tenant isolation (TRD-060)', () => {
  it('positive control: A lists its own rows through its own store', async () => {
    expect((await listFiscalYears(sqlA)).map((f) => f.name)).toEqual(['canary-a-fy-1', 'canary-a-fy-2'])
    expect(await typeNames(sqlA)).toEqual(['canary-a-type-1', 'canary-a-type-2'])
    expect((await listFiscalYears(sqlB)).map((f) => f.name)).toEqual(['canary-b-fy-1'])
  })

  it('each tenant is served from its own physical database', async () => {
    const [a] = await sqlA<{ db: string }[]>`SELECT current_database() AS db`
    const [b] = await sqlB<{ db: string }[]>`SELECT current_database() AS db`
    expect(a!.db).toBe(TEST_DB_PREFIX + A.slug)
    expect(b!.db).toBe(TEST_DB_PREFIX + B.slug)
    expect(a!.db).not.toBe(b!.db)
  })

  it("list: B lists none of A's rows and A lists none of B's", async () => {
    expect((await listFiscalYears(sqlB)).map((f) => f.name)).toEqual(['canary-b-fy-1'])
    expect(await typeNames(sqlB)).toEqual(['canary-b-type-1'])
    expect((await listFiscalYears(sqlA)).map((f) => f.name)).not.toContain('canary-b-fy-1')
    expect(await typeNames(sqlA)).not.toContain('canary-b-type-1')
  })

  it("read/update: B's update of A's fiscal-year id finds no row, and A's row is unchanged", async () => {
    expect(aFy2.id).not.toBe(bFy.id)
    expect(await updateFiscalYear(sqlB, aFy2.id, { name: 'hijacked-by-b', endDate: '2031-06-30' })).toBeNull()
    const a = await listFiscalYears(sqlA)
    expect(a.find((f) => f.id === aFy2.id)).toEqual(aFy2)
    expect((await listFiscalYears(sqlB)).map((f) => f.name)).toEqual(['canary-b-fy-1'])
  })

  it("update: the colliding id 1 resolves to each tenant's own row only", async () => {
    expect(aFy1.id).toBe(bFy.id)
    const updated = await updateFiscalYear(sqlB, bFy.id, { name: 'canary-b-fy-1-renamed' })
    expect(updated?.name).toBe('canary-b-fy-1-renamed')
    expect((await listFiscalYears(sqlA)).find((f) => f.id === aFy1.id)).toEqual(aFy1)
    await updateFiscalYear(sqlB, bFy.id, { name: 'canary-b-fy-1' })
  })

  it("delete: B's delete of A's sub-organisation-type id leaves A's row in place", async () => {
    expect(aType2.id).not.toBe(bType.id)
    await deleteSubOrgType(sqlB, aType2.id)
    expect(await typeNames(sqlA)).toEqual(['canary-a-type-1', 'canary-a-type-2'])
    expect(await typeNames(sqlB)).toEqual(['canary-b-type-1'])
  })

  it("delete: A's delete of its own type removes it from A only (positive control for the delete path)", async () => {
    await deleteSubOrgType(sqlA, aType1.id)
    expect(await typeNames(sqlA)).toEqual(['canary-a-type-2'])
    expect(await typeNames(sqlB)).toEqual(['canary-b-type-1'])
  })

  it("binding: B's id with A's slug, and A's id with B's slug, are refused, never served the other database", async () => {
    await expect(storeFor({ id: B.id, slug: A.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    await expect(storeFor({ id: A.id, slug: B.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    await _resetTenantStoreForTests()
    // Cold cache: the catalog alone must still refuse the forged pairs.
    await expect(storeFor({ id: B.id, slug: A.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    const freshA = await storeFor(A, OPTS)
    expect((await listFiscalYears(freshA)).map((f) => f.name)).toEqual(['canary-a-fy-1', 'canary-a-fy-2'])
    expect(await typeNames(freshA)).toEqual(['canary-a-type-2'])
  })
})
