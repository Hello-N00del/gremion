/**
 * Integration tests for services/calendar/src/store/*.ts
 *
 * Ports the SEMANTIC assertions from gremion-ui's calendar-db (Stream B1) plus
 * the leaf-owned CalDAV sync queue state machine.
 *
 * Must-cover contracts:
 *   - event CRUD (create/get/update/delete) incl. colour computation
 *   - deleteEventsByExternalId bulk-deletes + returns deleted ids
 *   - event_recurrence FK: recurrence persists across create/update, is
 *     deleted on ON DELETE CASCADE when the event is deleted
 *   - event_committees + committee_calendar_settings (colour resolution)
 *   - caldav_sync_queue state machine: enqueue on create/update/delete,
 *     listPendingCaldavSync / recordCaldavSyncFailure / listFailedCaldavSync
 *     / removeCaldavSyncEntry
 *   - event-type CRUD incl. system-type delete guard
 *   - calendar_audit insert
 *   - per-tenant isolation (two tenants never see each other's rows)
 *
 * Fail-closed guard: refuses to run unless host is localhost/127.0.0.1
 * and all test DBs use the calendar_test_ prefix.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { storeFor, _resetTenantStoreForTests, type TenantRef } from '../src/tenant-store.ts'
import {
  // events
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  deleteEventsByExternalId,
  // event types
  listEventTypes,
  getEventType,
  getEventTypeByName,
  createEventType,
  deleteEventType,
  // committees
  getCommitteeCalendarSettings,
  upsertCommitteeCalendarSettings,
  // caldav queue
  markCaldavSynced,
  listPendingCaldavSync,
  removeCaldavSyncEntry,
  recordCaldavSyncFailure,
  listFailedCaldavSync,
  // audit
  recordCalendarAudit,
} from '../src/store/index.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

// ── fail-closed guard (mirrors #249 / assert-safe-test-db-url pattern) ────────
const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'calendar_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

// ── test tenants ──────────────────────────────────────────────────────────────
const STORE_TENANT: TenantRef = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  slug: 'storetest',
}
const OTHER_TENANT: TenantRef = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  slug: 'othertest',
}

// ── helpers ───────────────────────────────────────────────────────────────────
let admin: ReturnType<typeof postgres>
let sql: Awaited<ReturnType<typeof storeFor>>
let otherSql: Awaited<ReturnType<typeof storeFor>>

async function dropTestDbs(pgSql: ReturnType<typeof postgres>): Promise<void> {
  const rows = await pgSql<{ datname: string }[]>`
    SELECT datname FROM pg_database
    WHERE datname LIKE 'calendar_test_%'
  `
  for (const { datname } of rows) {
    await pgSql.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${datname}' AND pid <> pg_backend_pid()`,
    )
    await pgSql.unsafe(`DROP DATABASE IF EXISTS "${datname}"`)
  }
}

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 1, prepare: false })
  await dropTestDbs(admin)
  sql = await storeFor(STORE_TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
  otherSql = await storeFor(OTHER_TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
})

afterAll(async () => {
  await _resetTenantStoreForTests()
  await dropTestDbs(admin)
  await admin.end()
})

// Clear all tables before each test for hermeticity.
async function clearAll(s: typeof sql): Promise<void> {
  await s`DELETE FROM calendar_audit`
  await s`DELETE FROM caldav_sync_queue`
  await s`DELETE FROM event_recurrence`
  await s`DELETE FROM event_committees`
  await s`DELETE FROM calendar_events`
  await s`DELETE FROM committee_calendar_settings`
  await s`DELETE FROM event_types WHERE is_system = false`
}

beforeEach(async () => {
  await clearAll(sql)
  await clearAll(otherSql)
})

// ── event CRUD ────────────────────────────────────────────────────────────────
describe('event CRUD', () => {
  it('creates and retrieves an event with computed colour', async () => {
    const created = await createEvent(sql, {
      title: 'Sitzung',
      description: null,
      location: null,
      startAt: new Date('2026-07-01T10:00:00Z'),
      endAt: new Date('2026-07-01T11:00:00Z'),
      allDay: false,
      eventTypeId: null,
      isMultiCommittee: false,
      createdBy: 'user-1',
      source: 'manual',
      externalId: null,
      committeeIds: [],
      recurrence: null,
    })
    expect(created.title).toBe('Sitzung')
    expect(created.caldavUid).toMatch(/@stura$/)
    expect(created.colour).toBeDefined()

    const got = await getEvent(sql, created.id)
    expect(got).toMatchObject({ id: created.id, title: 'Sitzung' })
  })

  it('getEvent returns null for a missing id', async () => {
    const got = await getEvent(sql, '00000000-0000-0000-0000-000000000000')
    expect(got).toBeNull()
  })

  it('updateEvent partial-updates fields and bumps updated_at', async () => {
    const created = await createEvent(sql, {
      title: 'Original',
      description: null,
      location: null,
      startAt: new Date('2026-07-01T10:00:00Z'),
      endAt: new Date('2026-07-01T11:00:00Z'),
      allDay: false,
      eventTypeId: null,
      isMultiCommittee: false,
      createdBy: 'user-1',
      source: 'manual',
      externalId: null,
      committeeIds: [],
      recurrence: null,
    })
    await new Promise((r) => setTimeout(r, 20))
    const updated = await updateEvent(sql, created.id, { title: 'Renamed' })
    expect(updated.title).toBe('Renamed')
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime())
  })

  it('deleteEvent removes the row and returns its caldav_uid', async () => {
    const created = await createEvent(sql, {
      title: 'ToDelete',
      description: null,
      location: null,
      startAt: new Date('2026-07-01T10:00:00Z'),
      endAt: new Date('2026-07-01T11:00:00Z'),
      allDay: false,
      eventTypeId: null,
      isMultiCommittee: false,
      createdBy: 'user-1',
      source: 'manual',
      externalId: null,
      committeeIds: [],
      recurrence: null,
    })
    const uid = await deleteEvent(sql, created.id)
    expect(uid).toBe(created.caldavUid)
    expect(await getEvent(sql, created.id)).toBeNull()
  })

  it('listEvents filters by [from, to) window', async () => {
    await createEvent(sql, {
      title: 'Early',
      description: null,
      location: null,
      startAt: new Date('2026-01-01T10:00:00Z'),
      endAt: new Date('2026-01-01T11:00:00Z'),
      allDay: false,
      eventTypeId: null,
      isMultiCommittee: false,
      createdBy: 'u',
      source: 'manual',
      externalId: null,
      committeeIds: [],
      recurrence: null,
    })
    const inWindow = await createEvent(sql, {
      title: 'InWindow',
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
    })
    const results = await listEvents(sql, {
      from: new Date('2026-06-01T00:00:00Z'),
      to: new Date('2026-08-01T00:00:00Z'),
    })
    expect(results.map((e) => e.id)).toEqual([inWindow.id])
  })

  it('deleteEventsByExternalId bulk-deletes matching rows and returns their ids', async () => {
    const helios1 = await createEvent(sql, {
      title: 'Helios 1',
      description: null,
      location: null,
      startAt: new Date('2026-07-01T10:00:00Z'),
      endAt: new Date('2026-07-01T11:00:00Z'),
      allDay: false,
      eventTypeId: null,
      isMultiCommittee: false,
      createdBy: 'u',
      source: 'helios',
      externalId: 'ext-1',
      committeeIds: [],
      recurrence: null,
    })
    const helios2 = await createEvent(sql, {
      title: 'Helios 2',
      description: null,
      location: null,
      startAt: new Date('2026-07-02T10:00:00Z'),
      endAt: new Date('2026-07-02T11:00:00Z'),
      allDay: false,
      eventTypeId: null,
      isMultiCommittee: false,
      createdBy: 'u',
      source: 'helios',
      externalId: 'ext-1',
      committeeIds: [],
      recurrence: null,
    })
    await createEvent(sql, {
      title: 'Other source',
      description: null,
      location: null,
      startAt: new Date('2026-07-03T10:00:00Z'),
      endAt: new Date('2026-07-03T11:00:00Z'),
      allDay: false,
      eventTypeId: null,
      isMultiCommittee: false,
      createdBy: 'u',
      source: 'manual',
      externalId: 'ext-1',
      committeeIds: [],
      recurrence: null,
    })
    const deletedIds = await deleteEventsByExternalId(sql, 'helios', 'ext-1')
    expect(deletedIds).toHaveLength(2)
    expect(new Set(deletedIds)).toEqual(new Set([helios1.id, helios2.id]))
    const remaining = await listEvents(sql)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.source).toBe('manual')
  })
})

// ── recurrence ────────────────────────────────────────────────────────────────
describe('recurrence', () => {
  it('persists recurrence on create and returns it on getEvent', async () => {
    const created = await createEvent(sql, {
      title: 'Weekly',
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
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        until: null,
        count: 10,
        byday: ['MO'],
        exceptions: null,
      },
    })
    expect(created.recurrence).toMatchObject({ frequency: 'weekly', interval: 1, count: 10 })
  })

  it('updateEvent replaces recurrence when provided', async () => {
    const created = await createEvent(sql, {
      title: 'Weekly',
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
      recurrence: { frequency: 'weekly', interval: 1, until: null, count: 10, byday: null, exceptions: null },
    })
    const updated = await updateEvent(sql, created.id, {
      recurrence: { frequency: 'monthly', interval: 2, until: null, count: null, byday: null, exceptions: null },
    })
    expect(updated.recurrence).toMatchObject({ frequency: 'monthly', interval: 2 })
  })

  it('updateEvent clears recurrence when explicitly set to null', async () => {
    const created = await createEvent(sql, {
      title: 'Weekly',
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
      recurrence: { frequency: 'weekly', interval: 1, until: null, count: 10, byday: null, exceptions: null },
    })
    const updated = await updateEvent(sql, created.id, { recurrence: null })
    expect(updated.recurrence).toBeNull()
  })

  it('ON DELETE CASCADE removes event_recurrence when the event is deleted', async () => {
    const created = await createEvent(sql, {
      title: 'Weekly',
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
      recurrence: { frequency: 'weekly', interval: 1, until: null, count: 10, byday: null, exceptions: null },
    })
    await deleteEvent(sql, created.id)
    const rows = await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM event_recurrence WHERE event_id = ${created.id}`
    expect(Number(rows[0]!.c)).toBe(0)
  })
})

// ── committees ────────────────────────────────────────────────────────────────
describe('committees + colour resolution', () => {
  const COMMITTEE_ID = '10000000-0000-0000-0000-000000000001'

  it('upserts and retrieves committee_calendar_settings', async () => {
    const settings = await upsertCommitteeCalendarSettings(sql, COMMITTEE_ID, '#123456')
    expect(settings.color).toBe('#123456')
    const got = await getCommitteeCalendarSettings(sql, COMMITTEE_ID)
    expect(got?.color).toBe('#123456')
  })

  it('upsert is idempotent (ON CONFLICT DO UPDATE)', async () => {
    await upsertCommitteeCalendarSettings(sql, COMMITTEE_ID, '#111111')
    const second = await upsertCommitteeCalendarSettings(sql, COMMITTEE_ID, '#222222')
    expect(second.color).toBe('#222222')
    const rows = await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM committee_calendar_settings WHERE committee_id = ${COMMITTEE_ID}`
    expect(Number(rows[0]!.c)).toBe(1)
  })

  it('single-committee event colour uses committee colour as primary', async () => {
    await upsertCommitteeCalendarSettings(sql, COMMITTEE_ID, '#abcdef')
    const created = await createEvent(sql, {
      title: 'Committee event',
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
      committeeIds: [COMMITTEE_ID],
      recurrence: null,
    })
    expect(created.colour.primary).toBe('#abcdef')
  })

  it('getCommitteeCalendarSettings returns null when not set', async () => {
    const got = await getCommitteeCalendarSettings(sql, '20000000-0000-0000-0000-000000000002')
    expect(got).toBeNull()
  })
})

// ── event types ───────────────────────────────────────────────────────────────
describe('event types', () => {
  it('lists system event types seeded by the migration', async () => {
    const types = await listEventTypes(sql)
    expect(types.length).toBeGreaterThanOrEqual(5)
    expect(types.some((t) => t.name === 'Treffen' && t.isSystem)).toBe(true)
  })

  it('creates a custom (non-system) event type', async () => {
    const created = await createEventType(sql, { name: 'Custom', color: '#000000' })
    expect(created.isSystem).toBe(false)
    const got = await getEventType(sql, created.id)
    expect(got?.name).toBe('Custom')
  })

  it('getEventTypeByName finds by name', async () => {
    const found = await getEventTypeByName(sql, 'Treffen')
    expect(found).not.toBeNull()
    expect(found?.name).toBe('Treffen')
  })

  it('deleteEventType removes a custom type', async () => {
    const created = await createEventType(sql, { name: 'Temp', color: '#fff' })
    await deleteEventType(sql, created.id)
    expect(await getEventType(sql, created.id)).toBeNull()
  })

  it('deleteEventType throws for a system type', async () => {
    const treffen = await getEventTypeByName(sql, 'Treffen')
    await expect(deleteEventType(sql, treffen!.id)).rejects.toThrow(/system/i)
  })

  it('deleteEventType throws for a missing type', async () => {
    await expect(deleteEventType(sql, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(/not found/i)
  })
})

// ── caldav sync queue ─────────────────────────────────────────────────────────
describe('caldav_sync_queue state machine', () => {
  it('createEvent enqueues a create operation', async () => {
    const created = await createEvent(sql, {
      title: 'Queued',
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
    })
    const pending = await listPendingCaldavSync(sql)
    expect(pending.some((p) => p.eventId === created.id && p.operation === 'create')).toBe(true)
  })

  it('updateEvent enqueues an update operation', async () => {
    const created = await createEvent(sql, {
      title: 'Queued',
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
    })
    await updateEvent(sql, created.id, { title: 'Renamed' })
    const pending = await listPendingCaldavSync(sql)
    expect(pending.filter((p) => p.eventId === created.id).map((p) => p.operation)).toEqual(
      expect.arrayContaining(['create', 'update']),
    )
  })

  it('deleteEvent enqueues a delete operation that survives event row removal', async () => {
    const created = await createEvent(sql, {
      title: 'Queued',
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
    })
    const caldavUid = created.caldavUid!
    await deleteEvent(sql, created.id)
    const pending = await listPendingCaldavSync(sql)
    const deleteEntry = pending.find((p) => p.caldavUid === caldavUid && p.operation === 'delete')
    expect(deleteEntry).toBeDefined()
    // event_id is nulled by ON DELETE SET NULL once the event row is gone.
    expect(deleteEntry!.eventId).toBeNull()
  })

  it('recordCaldavSyncFailure increments attempts and records the error', async () => {
    const created = await createEvent(sql, {
      title: 'Queued',
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
    })
    const pending = await listPendingCaldavSync(sql)
    const entry = pending.find((p) => p.eventId === created.id)!
    await recordCaldavSyncFailure(sql, entry.id, 'connection refused')
    const rows = await sql<{ attempts: number; last_error: string }[]>`
      SELECT attempts, last_error FROM caldav_sync_queue WHERE id = ${entry.id}
    `
    expect(rows[0]!.attempts).toBe(1)
    expect(rows[0]!.last_error).toBe('connection refused')
  })

  it('listFailedCaldavSync returns entries at/above maxAttempts, listPendingCaldavSync excludes them', async () => {
    const created = await createEvent(sql, {
      title: 'Queued',
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
    })
    const pending = await listPendingCaldavSync(sql)
    const entry = pending.find((p) => p.eventId === created.id)!
    await recordCaldavSyncFailure(sql, entry.id, 'err1')
    await recordCaldavSyncFailure(sql, entry.id, 'err2')
    await recordCaldavSyncFailure(sql, entry.id, 'err3')

    const failed = await listFailedCaldavSync(sql, 3)
    expect(failed.some((f) => f.id === entry.id)).toBe(true)

    const stillPending = await listPendingCaldavSync(sql, 3)
    expect(stillPending.some((p) => p.id === entry.id)).toBe(false)
  })

  it('removeCaldavSyncEntry deletes the queue row', async () => {
    const created = await createEvent(sql, {
      title: 'Queued',
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
    })
    const pending = await listPendingCaldavSync(sql)
    const entry = pending.find((p) => p.eventId === created.id)!
    await removeCaldavSyncEntry(sql, entry.id)
    const rows = await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM caldav_sync_queue WHERE id = ${entry.id}`
    expect(Number(rows[0]!.c)).toBe(0)
  })

  it('markCaldavSynced sets caldav_synced_at on the event', async () => {
    const created = await createEvent(sql, {
      title: 'Queued',
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
    })
    expect(created.caldavSyncedAt).toBeNull()
    await markCaldavSynced(sql, created.id)
    const got = await getEvent(sql, created.id)
    expect(got!.caldavSyncedAt).not.toBeNull()
  })
})

// ── audit ─────────────────────────────────────────────────────────────────────
describe('recordCalendarAudit', () => {
  it('inserts an audit row', async () => {
    const created = await createEvent(sql, {
      title: 'Audited',
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
    })
    await recordCalendarAudit(sql, created.id, 'user-sub', 'event.created')
    const rows = await sql<{ event_id: string; actor_sub: string; action: string }[]>`
      SELECT event_id, actor_sub, action FROM calendar_audit WHERE event_id = ${created.id}
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actor_sub).toBe('user-sub')
    expect(rows[0]!.action).toBe('event.created')
  })
})

// ── per-tenant isolation ──────────────────────────────────────────────────────
describe('per-tenant isolation', () => {
  it('events created in one tenant DB are invisible in another tenant DB', async () => {
    const created = await createEvent(sql, {
      title: 'Tenant A event',
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
    })
    expect(await getEvent(otherSql, created.id)).toBeNull()
    const otherEvents = await listEvents(otherSql)
    expect(otherEvents.map((e) => e.id)).not.toContain(created.id)
  })
})
