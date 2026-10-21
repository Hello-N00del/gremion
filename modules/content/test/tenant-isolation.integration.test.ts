/**
 * Cross-tenant data isolation for the content leaf (TRD-060 / TRD-061, audit
 * #534), against a real Postgres.
 *
 * Runs against CONTENT_TEST_PG_URL (a local throwaway Postgres instance).
 * Fail-closed guard: refuses to run unless the host is localhost/127.0.0.1, the
 * port is not 5432, and every test DB uses the `content_test_` prefix.
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
  createPost,
  getPost,
  listPosts,
  updatePost,
  createMailingList,
  listMailingLists,
  deleteMailingList,
  type ContentPost,
  type MailingList,
} from '../src/store/index.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'content_test_'
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
let aPost1: ContentPost
let aPost2: ContentPost
let bPost: ContentPost
let aList1: MailingList
let aList2: MailingList
let bList: MailingList

const post = (slug: string, title: string, createdBy: string) =>
  ({ slug, title, body_html: `<p>${title}</p>`, created_by: createdBy })

beforeAll(async () => {
  await wipe()
  sqlA = await storeFor(A, OPTS)
  sqlB = await storeFor(B, OPTS)
  aPost1 = await createPost(sqlA, post('a-one', 'canary-a-1', 'user-a'))
  aPost2 = await createPost(sqlA, post('a-two', 'canary-a-2', 'user-a'))
  bPost = await createPost(sqlB, post('b-one', 'canary-b-1', 'user-b'))
  aList1 = await createMailingList(sqlA, 'canary-a-list-1')
  aList2 = await createMailingList(sqlA, 'canary-a-list-2')
  bList = await createMailingList(sqlB, 'canary-b-list-1')
}, 60_000)

afterAll(wipe, 60_000)

describe('content leaf: two-tenant isolation (TRD-060)', () => {
  it('positive control: A reads and lists its own rows through its own store', async () => {
    expect((await getPost(sqlA, aPost1.id))?.title).toBe('canary-a-1')
    expect((await getPost(sqlA, aPost2.id))?.title).toBe('canary-a-2')
    expect((await listPosts(sqlA)).map((p) => p.title).sort()).toEqual(['canary-a-1', 'canary-a-2'])
    expect((await listMailingLists(sqlA)).map((l) => l.name).sort()).toEqual(['canary-a-list-1', 'canary-a-list-2'])
    expect((await getPost(sqlB, bPost.id))?.title).toBe('canary-b-1')
  })

  it('each tenant is served from its own physical database', async () => {
    const [a] = await sqlA<{ db: string }[]>`SELECT current_database() AS db`
    const [b] = await sqlB<{ db: string }[]>`SELECT current_database() AS db`
    expect(a!.db).toBe(TEST_DB_PREFIX + A.slug)
    expect(b!.db).toBe(TEST_DB_PREFIX + B.slug)
    expect(a!.db).not.toBe(b!.db)
  })

  it("read: A's ids return nothing through B's store, and B's id returns nothing through A's", async () => {
    expect(await getPost(sqlB, aPost1.id)).toBeNull()
    expect(await getPost(sqlB, aPost2.id)).toBeNull()
    expect(await getPost(sqlA, bPost.id)).toBeNull()
  })

  it("list: B lists none of A's rows and A lists none of B's", async () => {
    expect((await listPosts(sqlB)).map((p) => p.id)).toEqual([bPost.id])
    expect((await listMailingLists(sqlB)).map((l) => l.id)).toEqual([bList.id])
    expect((await listPosts(sqlA)).map((p) => p.id)).not.toContain(bPost.id)
    expect((await listMailingLists(sqlA)).map((l) => l.id)).not.toContain(bList.id)
  })

  it("update: B's update of A's post id changes nothing in A and creates nothing in B", async () => {
    await updatePost(sqlB, aPost2.id, { title: 'hijacked-by-b', body_html: '<p>hijacked</p>' })
    const after = await getPost(sqlA, aPost2.id)
    expect(after?.title).toBe('canary-a-2')
    expect(after?.body_html).toBe('<p>canary-a-2</p>')
    expect((await listPosts(sqlB)).map((p) => p.title)).toEqual(['canary-b-1'])
  })

  it("delete: B's delete of A's mailing-list id leaves A's list in place", async () => {
    await deleteMailingList(sqlB, aList2.id)
    expect((await listMailingLists(sqlA)).map((l) => l.id).sort()).toEqual([aList1.id, aList2.id].sort())
    expect((await listMailingLists(sqlB)).map((l) => l.id)).toEqual([bList.id])
  })

  it("delete: A's delete of its own list removes it from A only (positive control for the delete path)", async () => {
    await deleteMailingList(sqlA, aList1.id)
    expect((await listMailingLists(sqlA)).map((l) => l.id)).toEqual([aList2.id])
    expect((await listMailingLists(sqlB)).map((l) => l.id)).toEqual([bList.id])
  })

  it('uniqueness is per tenant: B can reuse a post slug A already holds', async () => {
    const same = await createPost(sqlB, post('a-one', 'canary-b-same-slug', 'user-b'))
    expect(same.id).not.toBe(aPost1.id)
    expect((await getPost(sqlA, aPost1.id))?.title).toBe('canary-a-1')
  })

  it("binding: B's id with A's slug, and A's id with B's slug, are refused, never served the other database", async () => {
    await expect(storeFor({ id: B.id, slug: A.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    await expect(storeFor({ id: A.id, slug: B.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    await _resetTenantStoreForTests()
    // Cold cache: the catalog alone must still refuse the forged pairs.
    await expect(storeFor({ id: B.id, slug: A.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    const freshA = await storeFor(A, OPTS)
    expect((await getPost(freshA, aPost1.id))?.title).toBe('canary-a-1')
    expect(await getPost(freshA, bPost.id)).toBeNull()
  })
})
