/**
 * F1-FIX-08-K integration guards (real Postgres).
 *
 *   - D-2 end to end: with a real queue, only is_public=true events are pushed.
 *   - K4#5: updateEvent can CLEAR description / location / event type (an explicit
 *     null used to be a silent no-op because of COALESCE(null, col)).
 *   - S1c#12 / S5#7: a recurring event is still returned for a window after its
 *     first occurrence (it used to vanish from every later window).
 *   - DbEvent.isPublic is exposed and defaults to false.
 *
 * Same fail-closed throwaway-PG guard as the other calendar integration suites.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { storeFor, _resetTenantStoreForTests, type TenantRef } from '../src/tenant-store.ts'
import {
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  createEventType,
  type CreateEventInput,
} from '../src/store/index.ts'
import { drainCaldavForTenant, _resetTenantDrainWarnings } from '../src/caldav/tenant-drain.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'calendar_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

const TENANT: TenantRef = { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', slug: 'f1fix08' }
let admin: ReturnType<typeof postgres>
let sql: Awaited<ReturnType<typeof storeFor>>

async function dropTestDbs(pg: ReturnType<typeof postgres>): Promise<void> {
  const rows = await pg<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname LIKE 'calendar_test_%'`
  for (const { datname } of rows) {
    await pg.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${datname}' AND pid <> pg_backend_pid()`,
    )
    await pg.unsafe(`DROP DATABASE IF EXISTS "${datname}"`)
  }
}

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 1, prepare: false })
  await dropTestDbs(admin)
  sql = await storeFor(TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
})
afterAll(async () => {
  await _resetTenantStoreForTests()
  await dropTestDbs(admin)
  await admin.end()
})
beforeEach(async () => {
  await sql`DELETE FROM caldav_sync_queue`
  await sql`DELETE FROM event_recurrence`
  await sql`DELETE FROM event_committees`
  await sql`DELETE FROM calendar_events`
  await sql`DELETE FROM event_types WHERE is_system = false`
  _resetTenantDrainWarnings()
})

function input(over: Partial<CreateEventInput> = {}): CreateEventInput {
  return {
    title: 'Termin',
    description: null,
    location: null,
    startAt: new Date('2026-07-01T10:00:00Z'),
    endAt: new Date('2026-07-01T11:00:00Z'),
    allDay: false,
    eventTypeId: null,
    isMultiCommittee: false,
    createdBy: 'u',
    source: 'manual',
    externalId: null,
    committeeIds: [],
    recurrence: null,
    ...over,
  }
}

describe('isPublic is exposed', () => {
  it('defaults to false and reflects an explicit true', async () => {
    const priv = await createEvent(sql, input())
    const pub = await createEvent(sql, input({ isPublic: true }))
    expect(priv.isPublic).toBe(false)
    expect(pub.isPublic).toBe(true)
    expect((await getEvent(sql, pub.id))!.isPublic).toBe(true)
    const flipped = await updateEvent(sql, pub.id, { isPublic: false })
    expect(flipped.isPublic).toBe(false)
  })
})

describe('D-2 end to end: only public events reach the calendar', () => {
  const ENV = {
    NEXTCLOUD_URL: 'http://nc.test',
    NEXTCLOUD_ADMIN_USER: 'admin',
    NEXTCLOUD_ADMIN_PASSWORD: 'pw',
    CALDAV_CALENDAR_TEMPLATE: 'stura-{slug}',
  }

  it('drains a mixed queue: the public event is PUT, the non-public one is never sent', async () => {
    const pub = await createEvent(sql, input({ title: 'Oeffentlich', isPublic: true }))
    const priv = await createEvent(sql, input({ title: 'Intern', isPublic: false }))

    const calls: { method: string; url: string; body: string }[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url), body: String(init?.body ?? '') })
      return new Response(null, { status: 201 })
    }) as unknown as typeof fetch

    const { createCalDavPusher } = await import('../src/caldav/pusher.ts')
    const result = await drainCaldavForTenant(sql, TENANT, {
      env: ENV,
      makePusher: (t) =>
        createCalDavPusher({
          nextcloudUrl: 'http://nc.test',
          adminUser: 'admin',
          adminPassword: 'pw',
          sharedUser: t.user,
          sharedCalendar: t.calendar,
          fetchImpl,
        }),
    })

    expect(result).toEqual({ succeeded: 2, failed: 0 }) // both rows retired
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts).toHaveLength(1)
    expect(puts[0]!.url).toContain(`/calendars/admin/stura-${TENANT.slug}/`)
    expect(puts[0]!.url).toContain(encodeURIComponent(pub.caldavUid!).replace(/%40/g, '@'))
    expect(puts[0]!.body).toContain('SUMMARY:Oeffentlich')
    // Nothing about the non-public event went over the wire, in any request.
    for (const c of calls) {
      expect(c.url).not.toContain(priv.caldavUid!)
      expect(c.body).not.toContain('Intern')
    }
  })

  it('an event flipped from public to non-public is retracted, not refreshed', async () => {
    const ev = await createEvent(sql, input({ title: 'War oeffentlich', isPublic: true }))
    await sql`DELETE FROM caldav_sync_queue`
    await updateEvent(sql, ev.id, { isPublic: false })

    const calls: { method: string; url: string }[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url) })
      return new Response(null, { status: 404 }) // already gone: still success
    }) as unknown as typeof fetch
    const { createCalDavPusher } = await import('../src/caldav/pusher.ts')
    const result = await drainCaldavForTenant(sql, TENANT, {
      env: ENV,
      makePusher: (t) =>
        createCalDavPusher({ nextcloudUrl: 'http://nc.test', adminUser: 'admin', adminPassword: 'pw', sharedUser: t.user, sharedCalendar: t.calendar, fetchImpl }),
    })

    expect(result).toEqual({ succeeded: 1, failed: 0 })
    expect(calls.map((c) => c.method)).toEqual(['DELETE'])
  })
})

describe('updateEvent can clear fields (K4#5)', () => {
  it('an explicit null clears description, location and event type; an absent key leaves them alone', async () => {
    const type = await createEventType(sql, { name: 'F1 Typ', color: '#123456' })
    const created = await createEvent(
      sql,
      input({ description: 'Beschreibung', location: 'Raum 1', eventTypeId: type.id }),
    )
    expect(created.description).toBe('Beschreibung')

    // Absent keys: untouched.
    const renamed = await updateEvent(sql, created.id, { title: 'Neu' })
    expect(renamed.description).toBe('Beschreibung')
    expect(renamed.location).toBe('Raum 1')
    expect(renamed.eventTypeId).toBe(type.id)

    // Explicit null: cleared.
    const cleared = await updateEvent(sql, created.id, { description: null, location: null, eventTypeId: null })
    expect(cleared.description).toBeNull()
    expect(cleared.location).toBeNull()
    expect(cleared.eventTypeId).toBeNull()
    expect(cleared.title).toBe('Neu')
  })
})

describe('recurring events stay visible in later windows (S1c#12 / S5#7)', () => {
  const weekly = {
    frequency: 'weekly' as const,
    interval: 1,
    until: null,
    count: null,
    byday: ['MO'],
    exceptions: null,
  }

  it('a weekly event whose first occurrence is before the window is returned for a later window', async () => {
    const rec = await createEvent(
      sql,
      input({
        title: 'Woechentlich',
        startAt: new Date('2026-01-05T10:00:00Z'),
        endAt: new Date('2026-01-05T11:00:00Z'),
        recurrence: weekly,
      }),
    )
    const later = await listEvents(sql, {
      from: new Date('2026-06-01T00:00:00Z'),
      to: new Date('2026-06-30T00:00:00Z'),
    })
    expect(later.map((e) => e.id)).toContain(rec.id)
  })

  it('a recurrence that ENDED before the window is not returned; a not-yet-started one is not either', async () => {
    const ended = await createEvent(
      sql,
      input({
        title: 'Beendet',
        startAt: new Date('2026-01-05T10:00:00Z'),
        endAt: new Date('2026-01-05T11:00:00Z'),
        recurrence: { ...weekly, until: new Date('2026-02-01T00:00:00Z') },
      }),
    )
    const future = await createEvent(
      sql,
      input({
        title: 'Zukunft',
        startAt: new Date('2026-09-07T10:00:00Z'),
        endAt: new Date('2026-09-07T11:00:00Z'),
        recurrence: weekly,
      }),
    )
    const ids = (
      await listEvents(sql, { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-06-30T00:00:00Z') })
    ).map((e) => e.id)
    expect(ids).not.toContain(ended.id)
    expect(ids).not.toContain(future.id)
  })

  it('a non-recurring event outside the window is still excluded, and the committee filter still applies', async () => {
    const committee = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    const other = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
    const inC = await createEvent(sql, input({ title: 'C', committeeIds: [committee], recurrence: weekly }))
    const inOther = await createEvent(sql, input({ title: 'O', committeeIds: [other], recurrence: weekly }))
    const plainOutside = await createEvent(
      sql,
      input({
        title: 'Aussen',
        committeeIds: [committee],
        startAt: new Date('2026-01-01T10:00:00Z'),
        endAt: new Date('2026-01-01T11:00:00Z'),
      }),
    )
    const ids = (
      await listEvents(sql, {
        from: new Date('2026-07-01T00:00:00Z'),
        to: new Date('2026-07-30T00:00:00Z'),
        committeeId: committee,
      })
    ).map((e) => e.id)
    expect(ids).toContain(inC.id)
    expect(ids).not.toContain(inOther.id)
    expect(ids).not.toContain(plainOutside.id)
  })
})
