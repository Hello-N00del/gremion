/**
 * Cross-tenant data isolation for the calendar leaf (TRD-060 / TRD-061, audit
 * #534), against a real Postgres.
 *
 * Runs against CALENDAR_TEST_PG_URL (a local throwaway Postgres instance).
 * Fail-closed guard: refuses to run unless the host is localhost/127.0.0.1, the
 * port is not 5432, and every test DB uses the `calendar_test_` prefix.
 *
 * Two tenants, A and B, are served by the leaf's own storeFor(). Events written
 * through A's store must not be readable, listable, updatable or deletable
 * through B's store, and B's ids must not address A's rows (and the reverse).
 * The CalDAV sync queue is per tenant too. The (id, slug) binding is checked as
 * well: B's id with A's slug, and A's id with B's slug, are refused rather than
 * served A's database.
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
  createEvent,
  getEvent,
  listEvents,
  updateEvent,
  deleteEvent,
  type DbEvent,
} from '../src/store/index.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'calendar_test_'
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
let aEvent1: DbEvent
let aEvent2: DbEvent
let bEvent: DbEvent

function event(title: string, createdBy: string) {
  return {
    title,
    description: null,
    location: null,
    startAt: new Date('2030-05-01T10:00:00Z'),
    endAt: new Date('2030-05-01T11:00:00Z'),
    allDay: false,
    isPublic: false,
    eventTypeId: null,
    isMultiCommittee: false,
    createdBy,
    source: 'manual' as const,
    externalId: null,
    committeeIds: [],
    recurrence: null,
  }
}

const queueRows = async (sql: Store, eventId: string): Promise<number> => {
  const [r] = await sql<{ c: string }[]>`SELECT count(*) AS c FROM caldav_sync_queue WHERE event_id = ${eventId}`
  return Number(r!.c)
}

beforeAll(async () => {
  await wipe()
  sqlA = await storeFor(A, OPTS)
  sqlB = await storeFor(B, OPTS)
  aEvent1 = await createEvent(sqlA, event('canary-a-1', 'user-a'))
  aEvent2 = await createEvent(sqlA, event('canary-a-2', 'user-a'))
  bEvent = await createEvent(sqlB, event('canary-b-1', 'user-b'))
}, 60_000)

afterAll(wipe, 60_000)

describe('calendar leaf: two-tenant isolation (TRD-060)', () => {
  it('positive control: A reads, lists and has queued sync for its own events', async () => {
    expect((await getEvent(sqlA, aEvent1.id))?.title).toBe('canary-a-1')
    expect((await getEvent(sqlA, aEvent2.id))?.title).toBe('canary-a-2')
    expect((await listEvents(sqlA)).map((e) => e.title).sort()).toEqual(['canary-a-1', 'canary-a-2'])
    expect(await queueRows(sqlA, aEvent2.id)).toBe(1)
    expect((await getEvent(sqlB, bEvent.id))?.title).toBe('canary-b-1')
  })

  it('each tenant is served from its own physical database', async () => {
    const [a] = await sqlA<{ db: string }[]>`SELECT current_database() AS db`
    const [b] = await sqlB<{ db: string }[]>`SELECT current_database() AS db`
    expect(a!.db).toBe(TEST_DB_PREFIX + A.slug)
    expect(b!.db).toBe(TEST_DB_PREFIX + B.slug)
    expect(a!.db).not.toBe(b!.db)
  })

  it("read: A's ids return nothing through B's store, and B's id returns nothing through A's", async () => {
    expect(await getEvent(sqlB, aEvent1.id)).toBeNull()
    expect(await getEvent(sqlB, aEvent2.id)).toBeNull()
    expect(await getEvent(sqlA, bEvent.id)).toBeNull()
  })

  it("list: B lists none of A's events and A lists none of B's", async () => {
    expect((await listEvents(sqlB)).map((e) => e.id)).toEqual([bEvent.id])
    expect((await listEvents(sqlA)).map((e) => e.id)).not.toContain(bEvent.id)
  })

  it("update: B's update of A's event id is refused and changes nothing in A", async () => {
    await expect(updateEvent(sqlB, aEvent2.id, { title: 'hijacked-by-b', location: 'b-room' })).rejects.toThrow(/updateEvent: event .* vanished/)
    const after = await getEvent(sqlA, aEvent2.id)
    expect(after?.title).toBe('canary-a-2')
    expect(after?.location).toBeNull()
    expect((await listEvents(sqlB)).map((e) => e.title)).toEqual(['canary-b-1'])
  })

  it("delete: B's delete of A's event id leaves A's event and its queue in place", async () => {
    await deleteEvent(sqlB, aEvent2.id)
    expect((await getEvent(sqlA, aEvent2.id))?.title).toBe('canary-a-2')
    expect(await queueRows(sqlA, aEvent2.id)).toBe(1)
    expect(await queueRows(sqlB, aEvent2.id)).toBe(0)
    expect((await listEvents(sqlB)).map((e) => e.id)).toEqual([bEvent.id])
  })

  it("delete: A's delete of its own event removes it from A only (positive control for the delete path)", async () => {
    await deleteEvent(sqlA, aEvent1.id)
    expect(await getEvent(sqlA, aEvent1.id)).toBeNull()
    expect((await listEvents(sqlA)).map((e) => e.id)).toEqual([aEvent2.id])
    expect((await listEvents(sqlB)).map((e) => e.id)).toEqual([bEvent.id])
  })

  it("binding: B's id with A's slug, and A's id with B's slug, are refused, never served the other database", async () => {
    await expect(storeFor({ id: B.id, slug: A.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    await expect(storeFor({ id: A.id, slug: B.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    await _resetTenantStoreForTests()
    // Cold cache: the catalog alone must still refuse the forged pairs.
    await expect(storeFor({ id: B.id, slug: A.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    const freshA = await storeFor(A, OPTS)
    expect((await getEvent(freshA, aEvent2.id))?.title).toBe('canary-a-2')
    expect(await getEvent(freshA, bEvent.id)).toBeNull()
  })
})
