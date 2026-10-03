// gremion-ui/src/lib/server/calendar/backend/inprocess-client.test.ts
// Task 2 — unit test for InprocessCalendarClient.
// Stubs calendar-db so this test has zero DB dependencies.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Stub calendar-db ──────────────────────────────────────────────────────────
// Use vi.hoisted() so the mock variables are available when vi.mock() factory
// executes (vi.mock calls are hoisted to the top of the module).
const {
  mockListEvents,
  mockGetEvent,
  mockCreateEvent,
  mockUpdateEvent,
  mockDeleteEvent,
  mockDeleteEventsByExternalId,
  mockFindEventByExternalId,
  mockListEventTypes,
  mockGetEventType,
  mockGetEventTypeByName,
  mockCreateEventType,
  mockDeleteEventType,
  mockGetCommitteeCalendarSettings,
  mockUpsertCommitteeCalendarSettings,
  mockListFailedCaldavSync,
} = vi.hoisted(() => ({
  mockListEvents: vi.fn(),
  mockGetEvent: vi.fn(),
  mockCreateEvent: vi.fn(),
  mockUpdateEvent: vi.fn(),
  mockDeleteEvent: vi.fn(),
  mockDeleteEventsByExternalId: vi.fn(),
  mockFindEventByExternalId: vi.fn(),
  mockListEventTypes: vi.fn(),
  mockGetEventType: vi.fn(),
  mockGetEventTypeByName: vi.fn(),
  mockCreateEventType: vi.fn(),
  mockDeleteEventType: vi.fn(),
  mockGetCommitteeCalendarSettings: vi.fn(),
  mockUpsertCommitteeCalendarSettings: vi.fn(),
  mockListFailedCaldavSync: vi.fn(),
}))

vi.mock('../calendar-db', () => ({
  listEvents: mockListEvents,
  getEvent: mockGetEvent,
  createEvent: mockCreateEvent,
  updateEvent: mockUpdateEvent,
  deleteEvent: mockDeleteEvent,
  deleteEventsByExternalId: mockDeleteEventsByExternalId,
  findEventByExternalId: mockFindEventByExternalId,
  listEventTypes: mockListEventTypes,
  getEventType: mockGetEventType,
  getEventTypeByName: mockGetEventTypeByName,
  createEventType: mockCreateEventType,
  deleteEventType: mockDeleteEventType,
  getCommitteeCalendarSettings: mockGetCommitteeCalendarSettings,
  upsertCommitteeCalendarSettings: mockUpsertCommitteeCalendarSettings,
  listFailedCaldavSync: mockListFailedCaldavSync,
}))

import { InprocessCalendarClient } from './inprocess-client'
import type { CreateEventInput, DbEvent } from './port'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<DbEvent> = {}): DbEvent {
  return {
    id: 'ev-1',
    title: 'Test event',
    description: null,
    location: null,
    startAt: new Date('2025-01-01T10:00:00Z'),
    endAt: new Date('2025-01-01T11:00:00Z'),
    allDay: false,
    eventTypeId: null,
    eventTypeColor: null,
    eventTypeName: null,
    isMultiCommittee: false,
    createdBy: 'user-1',
    source: 'manual',
    externalId: null,
    caldavUid: 'uid@stura',
    caldavSyncedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    committeeIds: [],
    recurrence: null,
    colour: { primary: '#888', secondary: '#ccc' },
    readOnly: false,
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('InprocessCalendarClient', () => {
  let client: InprocessCalendarClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new InprocessCalendarClient()
  })

  it('has kind === inprocess', () => {
    expect(client.kind).toBe('inprocess')
  })

  it('createEvent delegates to calendar-db.createEvent and returns the result', async () => {
    const event = makeEvent()
    mockCreateEvent.mockResolvedValueOnce(event)

    const input: CreateEventInput = {
      title: 'Test event',
      description: null,
      location: null,
      startAt: new Date('2025-01-01T10:00:00Z'),
      endAt: new Date('2025-01-01T11:00:00Z'),
      allDay: false,
      eventTypeId: null,
      isMultiCommittee: false,
      createdBy: 'user-1',
      source: 'manual',
      externalId: null,
      committeeIds: [],
      recurrence: null,
    }

    const result = await client.createEvent(input)
    expect(mockCreateEvent).toHaveBeenCalledOnce()
    expect(mockCreateEvent).toHaveBeenCalledWith(input)
    expect(result).toBe(event)
  })

  it('getEvent returns null when calendar-db.getEvent returns null', async () => {
    mockGetEvent.mockResolvedValueOnce(null)
    const result = await client.getEvent('missing-id')
    expect(mockGetEvent).toHaveBeenCalledWith('missing-id')
    expect(result).toBeNull()
  })

  it('getEvent passes through the event when found', async () => {
    const event = makeEvent({ id: 'ev-found' })
    mockGetEvent.mockResolvedValueOnce(event)
    const result = await client.getEvent('ev-found')
    expect(result).toBe(event)
  })

  it('listEvents delegates with no filter by default', async () => {
    mockListEvents.mockResolvedValueOnce([])
    await client.listEvents()
    expect(mockListEvents).toHaveBeenCalledOnce()
    expect(mockListEvents).toHaveBeenCalledWith(undefined)
  })

  it('listEvents passes a filter through', async () => {
    const filter = { from: new Date('2025-01-01'), committeeId: 'c-1' }
    mockListEvents.mockResolvedValueOnce([])
    await client.listEvents(filter)
    expect(mockListEvents).toHaveBeenCalledWith(filter)
  })

  it('updateEvent delegates correctly', async () => {
    const event = makeEvent({ title: 'Updated' })
    mockUpdateEvent.mockResolvedValueOnce(event)
    const result = await client.updateEvent('ev-1', { title: 'Updated' })
    expect(mockUpdateEvent).toHaveBeenCalledWith('ev-1', { title: 'Updated' })
    expect(result).toBe(event)
  })

  it('deleteEvent delegates and returns caldav_uid string or null', async () => {
    mockDeleteEvent.mockResolvedValueOnce('uid@stura')
    const result = await client.deleteEvent('ev-1')
    expect(mockDeleteEvent).toHaveBeenCalledWith('ev-1')
    expect(result).toBe('uid@stura')
  })

  it('deleteEventsByExternalId delegates', async () => {
    mockDeleteEventsByExternalId.mockResolvedValueOnce(undefined)
    await client.deleteEventsByExternalId('helios', 'ext-123')
    expect(mockDeleteEventsByExternalId).toHaveBeenCalledWith('helios', 'ext-123')
  })

  it('findEventByExternalId delegates and passes the result through', async () => {
    const event = makeEvent({ id: 'ev-hol', source: 'holiday', externalId: 'h-1' })
    mockFindEventByExternalId.mockResolvedValueOnce(event)
    const result = await client.findEventByExternalId('holiday', 'h-1')
    expect(mockFindEventByExternalId).toHaveBeenCalledWith('holiday', 'h-1')
    expect(result).toBe(event)
  })

  it('findEventByExternalId returns null when calendar-db returns null', async () => {
    mockFindEventByExternalId.mockResolvedValueOnce(null)
    const result = await client.findEventByExternalId('holiday', 'missing')
    expect(result).toBeNull()
  })

  it('listEventTypes delegates', async () => {
    mockListEventTypes.mockResolvedValueOnce([])
    const result = await client.listEventTypes()
    expect(mockListEventTypes).toHaveBeenCalledOnce()
    expect(result).toEqual([])
  })

  it('getEventType delegates', async () => {
    mockGetEventType.mockResolvedValueOnce(null)
    await client.getEventType('et-1')
    expect(mockGetEventType).toHaveBeenCalledWith('et-1')
  })

  it('getEventTypeByName delegates', async () => {
    mockGetEventTypeByName.mockResolvedValueOnce(null)
    await client.getEventTypeByName('Sitzung')
    expect(mockGetEventTypeByName).toHaveBeenCalledWith('Sitzung')
  })

  it('createEventType delegates', async () => {
    const et = { id: 'et-new', name: 'Sitzung', color: '#f00', isSystem: false, createdAt: new Date() }
    mockCreateEventType.mockResolvedValueOnce(et)
    const result = await client.createEventType({ name: 'Sitzung', color: '#f00' })
    expect(mockCreateEventType).toHaveBeenCalledWith({ name: 'Sitzung', color: '#f00' })
    expect(result).toBe(et)
  })

  it('deleteEventType delegates', async () => {
    mockDeleteEventType.mockResolvedValueOnce(undefined)
    await client.deleteEventType('et-1')
    expect(mockDeleteEventType).toHaveBeenCalledWith('et-1')
  })

  it('getCommitteeCalendarSettings delegates', async () => {
    mockGetCommitteeCalendarSettings.mockResolvedValueOnce(null)
    await client.getCommitteeCalendarSettings('c-1')
    expect(mockGetCommitteeCalendarSettings).toHaveBeenCalledWith('c-1')
  })

  it('upsertCommitteeCalendarSettings delegates', async () => {
    const settings = { committeeId: 'c-1', color: '#f00', updatedAt: new Date() }
    mockUpsertCommitteeCalendarSettings.mockResolvedValueOnce(settings)
    const result = await client.upsertCommitteeCalendarSettings('c-1', '#f00')
    expect(mockUpsertCommitteeCalendarSettings).toHaveBeenCalledWith('c-1', '#f00')
    expect(result).toBe(settings)
  })

  it('listFailedCaldavSync delegates', async () => {
    mockListFailedCaldavSync.mockResolvedValueOnce([])
    const result = await client.listFailedCaldavSync()
    expect(mockListFailedCaldavSync).toHaveBeenCalledOnce()
    expect(result).toEqual([])
  })
})
