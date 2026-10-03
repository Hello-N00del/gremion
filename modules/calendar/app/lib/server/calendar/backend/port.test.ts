// port.test.ts — Task 1: structural type check for CalendarBackendPort + domain DTOs.
// This is a type-only test: a structural stub that satisfies the interface proves
// the shape is correct. No runtime DB access.

import { describe, it, expect } from 'vitest'
import type {
  CalendarBackendPort,
  DbEvent,
  DbEventType,
  DbRecurrence,
  DbCommitteeCalendarSettings,
  DbCalDavQueueEntry,
  CreateEventInput,
  UpdateEventInput,
  ListEventsFilter,
  EventSource,
  RecurrenceFrequency,
  CaldavOperation,
} from './port'

describe('CalendarBackendPort — structural type tests', () => {
  it('EventSource union contains exactly the expected members', () => {
    const sources: EventSource[] = ['manual', 'helios', 'minutes', 'holiday', 'newsletter']
    expect(sources).toHaveLength(5)
  })

  it('RecurrenceFrequency union contains exactly the expected members', () => {
    const freqs: RecurrenceFrequency[] = ['daily', 'weekly', 'monthly', 'yearly']
    expect(freqs).toHaveLength(4)
  })

  it('CaldavOperation union contains exactly the expected members', () => {
    const ops: CaldavOperation[] = ['create', 'update', 'delete']
    expect(ops).toHaveLength(3)
  })

  it('DbEvent DTO can be constructed with all required fields', () => {
    const event: DbEvent = {
      id: 'evt-1',
      title: 'Test Event',
      description: null,
      location: null,
      startAt: new Date('2026-01-01T10:00:00Z'),
      endAt: new Date('2026-01-01T11:00:00Z'),
      allDay: false,
      eventTypeId: null,
      eventTypeColor: null,
      eventTypeName: null,
      isMultiCommittee: false,
      createdBy: 'user-sub',
      source: 'manual',
      externalId: null,
      caldavUid: null,
      caldavSyncedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      committeeIds: [],
      recurrence: null,
      colour: { primary: '#aabbcc', secondary: '#ddeeff' },
      readOnly: false,
    }
    expect(event.id).toBe('evt-1')
    expect(event.colour.primary).toBe('#aabbcc')
  })

  it('DbEventType DTO can be constructed', () => {
    const et: DbEventType = {
      id: 'et-1',
      name: 'Meeting',
      color: '#ff0000',
      isSystem: false,
      createdAt: new Date(),
    }
    expect(et.name).toBe('Meeting')
  })

  it('DbRecurrence DTO can be constructed', () => {
    const rec: DbRecurrence = {
      frequency: 'weekly',
      interval: 1,
      until: null,
      count: null,
      byday: ['MO', 'WE'],
      exceptions: null,
    }
    expect(rec.frequency).toBe('weekly')
  })

  it('DbCommitteeCalendarSettings DTO can be constructed', () => {
    const s: DbCommitteeCalendarSettings = {
      committeeId: 'c-1',
      color: '#00ff00',
      updatedAt: new Date(),
    }
    expect(s.committeeId).toBe('c-1')
  })

  it('DbCalDavQueueEntry DTO can be constructed', () => {
    const entry: DbCalDavQueueEntry = {
      id: 'q-1',
      eventId: 'evt-1',
      caldavUid: 'uid@stura',
      operation: 'create',
      attempts: 0,
      lastError: null,
      createdAt: new Date(),
    }
    expect(entry.operation).toBe('create')
  })

  it('CreateEventInput can be constructed', () => {
    const input: CreateEventInput = {
      title: 'New Event',
      description: null,
      location: null,
      startAt: new Date(),
      endAt: new Date(),
      allDay: false,
      eventTypeId: null,
      isMultiCommittee: false,
      createdBy: 'user-sub',
      source: 'manual',
      externalId: null,
      committeeIds: [],
      recurrence: null,
    }
    expect(input.title).toBe('New Event')
  })

  it('UpdateEventInput can be constructed with partial fields', () => {
    const input: UpdateEventInput = {
      title: 'Updated',
    }
    expect(input.title).toBe('Updated')
  })

  it('ListEventsFilter can be constructed with all optional fields', () => {
    const filter: ListEventsFilter = {
      from: new Date(),
      to: new Date(),
      committeeId: 'c-1',
      eventTypeId: 'et-1',
    }
    expect(filter.committeeId).toBe('c-1')
  })

  it('a structural stub satisfies CalendarBackendPort', () => {
    // Build a minimal stub that the TS compiler accepts as CalendarBackendPort
    const stub: CalendarBackendPort = {
      kind: 'inprocess',
      listEvents: async () => [],
      getEvent: async () => null,
      createEvent: async () => {
        throw new Error('stub')
      },
      updateEvent: async () => {
        throw new Error('stub')
      },
      deleteEvent: async () => null,
      deleteEventsByExternalId: async () => {},
      findEventByExternalId: async () => null,
      listEventTypes: async () => [],
      getEventType: async () => null,
      getEventTypeByName: async () => null,
      createEventType: async () => {
        throw new Error('stub')
      },
      deleteEventType: async () => {},
      getCommitteeCalendarSettings: async () => null,
      upsertCommitteeCalendarSettings: async () => {
        throw new Error('stub')
      },
      listFailedCaldavSync: async () => [],
    }
    expect(stub.kind).toBe('inprocess')
    expect(typeof stub.listEvents).toBe('function')
    expect(typeof stub.listFailedCaldavSync).toBe('function')
    expect(typeof stub.findEventByExternalId).toBe('function')
  })
})
