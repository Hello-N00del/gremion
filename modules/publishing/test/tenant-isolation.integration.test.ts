/**
 * Cross-tenant data isolation for the newsletter leaf (TRD-060 / TRD-061, audit
 * #534), against a real Postgres.
 *
 * Runs against NEWSLETTER_TEST_PG_URL (a local throwaway Postgres instance).
 * Fail-closed guard: refuses to run unless the host is localhost/127.0.0.1, the
 * port is not 5432, and every test DB uses the `newsletter_test_` prefix.
 *
 * Two tenants, A and B, are served by the leaf's own storeFor(). Rows written
 * through A's store must not be readable, listable, updatable or deletable
 * through B's store, and B's ids must not address A's rows (and the reverse).
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
  createNewsletter,
  getNewsletter,
  listNewsletters,
  updateNewsletter,
  createMailingList,
  listMailingLists,
  deleteMailingList,
  type Newsletter,
  type MailingList,
} from '../src/store/index.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'newsletter_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

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

let sqlA: Store
let sqlB: Store
// Ids are per-database serials: A holds 1 and 2, B holds 1. Every cross-tenant
// attempt uses A's id 2, which B does not hold, so a miss cannot be mistaken for
// B legitimately addressing its own row 1.
let aNl1: Newsletter
let aNl2: Newsletter
let bNl: Newsletter
let aList1: MailingList
let aList2: MailingList
let bList: MailingList

const newsletter = (title: string, createdBy: string) =>
  ({ title, odt_path: `/files/${title}.odt`, subject: `subject ${title}`, created_by: createdBy })

beforeAll(async () => {
  await wipe()
  sqlA = await storeFor(A, OPTS)
  sqlB = await storeFor(B, OPTS)
  aNl1 = await createNewsletter(sqlA, newsletter('canary-a-1', 'user-a'))
  aNl2 = await createNewsletter(sqlA, newsletter('canary-a-2', 'user-a'))
  bNl = await createNewsletter(sqlB, newsletter('canary-b-1', 'user-b'))
  aList1 = await createMailingList(sqlA, 'canary-a-list-1')
  aList2 = await createMailingList(sqlA, 'canary-a-list-2')
  bList = await createMailingList(sqlB, 'canary-b-list-1')
}, 60_000)

afterAll(wipe, 60_000)

describe('newsletter leaf: two-tenant isolation (TRD-060)', () => {
  it('positive control: A reads and lists its own rows through its own store', async () => {
    expect((await getNewsletter(sqlA, aNl1.id))?.title).toBe('canary-a-1')
    expect((await getNewsletter(sqlA, aNl2.id))?.title).toBe('canary-a-2')
    expect((await listNewsletters(sqlA)).map((x) => x.title).sort()).toEqual(['canary-a-1', 'canary-a-2'])
    expect((await listMailingLists(sqlA)).map((l) => l.name).sort()).toEqual(['canary-a-list-1', 'canary-a-list-2'])
    expect((await getNewsletter(sqlB, bNl.id))?.title).toBe('canary-b-1')
  })

  it('each tenant is served from its own physical database', async () => {
    const [a] = await sqlA<{ db: string }[]>`SELECT current_database() AS db`
    const [b] = await sqlB<{ db: string }[]>`SELECT current_database() AS db`
    expect(a!.db).toBe(TEST_DB_PREFIX + A.slug)
    expect(b!.db).toBe(TEST_DB_PREFIX + B.slug)
    expect(a!.db).not.toBe(b!.db)
  })

  it("read: A's id 2 returns nothing through B's store; the colliding id 1 resolves to each tenant's own row only", async () => {
    expect(aNl2.id).not.toBe(bNl.id)
    expect(await getNewsletter(sqlB, aNl2.id)).toBeNull()
    expect(aNl1.id).toBe(bNl.id)
    expect((await getNewsletter(sqlB, aNl1.id))?.title).toBe('canary-b-1')
    expect((await getNewsletter(sqlA, bNl.id))?.title).toBe('canary-a-1')
  })

  it("list: B lists none of A's rows and A lists none of B's", async () => {
    expect((await listNewsletters(sqlB)).map((x) => x.title)).toEqual(['canary-b-1'])
    expect((await listMailingLists(sqlB)).map((l) => l.name)).toEqual(['canary-b-list-1'])
    expect((await listNewsletters(sqlA)).map((x) => x.title)).not.toContain('canary-b-1')
    expect((await listMailingLists(sqlA)).map((l) => l.name)).not.toContain('canary-b-list-1')
  })

  it("update: B's update of A's newsletter id changes nothing in A and creates nothing in B", async () => {
    await updateNewsletter(sqlB, aNl2.id, { subject: 'hijacked-by-b', status: 'failed', error: 'x' })
    const after = await getNewsletter(sqlA, aNl2.id)
    expect(after?.subject).toBe('subject canary-a-2')
    expect(after?.status).toBe('draft')
    expect(after?.error).toBeNull()
    const b = await listNewsletters(sqlB)
    expect(b.map((x) => x.subject)).toEqual(['subject canary-b-1'])
    expect(b.map((x) => x.status)).toEqual(['draft'])
  })

  it("delete: B's delete of A's mailing-list id leaves A's list in place", async () => {
    expect(aList2.id).not.toBe(bList.id)
    await deleteMailingList(sqlB, aList2.id)
    expect((await listMailingLists(sqlA)).map((l) => l.id).sort((x, y) => x - y)).toEqual([aList1.id, aList2.id].sort((x, y) => x - y))
    expect((await listMailingLists(sqlB)).map((l) => l.id)).toEqual([bList.id])
  })

  it("delete: A's delete of its own list removes it from A only (positive control for the delete path)", async () => {
    await deleteMailingList(sqlA, aList1.id)
    expect((await listMailingLists(sqlA)).map((l) => l.id)).toEqual([aList2.id])
    expect((await listMailingLists(sqlB)).map((l) => l.id)).toEqual([bList.id])
  })

  it("binding: B's id with A's slug, and A's id with B's slug, are refused, never served the other database", async () => {
    await expect(storeFor({ id: B.id, slug: A.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    await expect(storeFor({ id: A.id, slug: B.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    await _resetTenantStoreForTests()
    // Cold cache: the catalog alone must still refuse the forged pairs.
    await expect(storeFor({ id: B.id, slug: A.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    const freshA = await storeFor(A, OPTS)
    expect((await getNewsletter(freshA, aNl2.id))?.title).toBe('canary-a-2')
    expect((await listNewsletters(freshA)).map((x) => x.title)).not.toContain('canary-b-1')
  })
})
