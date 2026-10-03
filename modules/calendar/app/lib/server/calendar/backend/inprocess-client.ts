// gremion-ui/src/lib/server/calendar/backend/inprocess-client.ts
// branch-by-abstraction default path; byte-identical to current behavior until
// the deliberate (held) cutover to 'service'.
//
// Every method is a thin async delegate to the corresponding calendar-db export.
// No logic lives here — callers should use CalendarBackendPort, not this class directly.

import type { CalendarBackendPort } from './port'
import type {
  DbEvent,
  DbEventType,
  DbCommitteeCalendarSettings,
  DbCalDavQueueEntry,
  CreateEventInput,
  UpdateEventInput,
  ListEventsFilter,
  EventSource,
} from './port'
import * as db from '../calendar-db'

export class InprocessCalendarClient implements CalendarBackendPort {
  readonly kind = 'inprocess' as const

  // ── Events ─────────────────────────────────────────────────────────────────

  async listEvents(filter?: ListEventsFilter): Promise<DbEvent[]> {
    return db.listEvents(filter)
  }

  async getEvent(id: string): Promise<DbEvent | null> {
    return db.getEvent(id)
  }

  async createEvent(input: CreateEventInput): Promise<DbEvent> {
    return db.createEvent(input)
  }

  async updateEvent(id: string, input: UpdateEventInput): Promise<DbEvent> {
    return db.updateEvent(id, input)
  }

  async deleteEvent(id: string): Promise<string | null> {
    return db.deleteEvent(id)
  }

  async deleteEventsByExternalId(source: EventSource, externalId: string): Promise<void> {
    await db.deleteEventsByExternalId(source, externalId)
  }

  async findEventByExternalId(source: EventSource, externalId: string): Promise<DbEvent | null> {
    return db.findEventByExternalId(source, externalId)
  }

  // ── Event types ───────────────────────────────────────────────────────────

  async listEventTypes(): Promise<DbEventType[]> {
    return db.listEventTypes()
  }

  async getEventType(id: string): Promise<DbEventType | null> {
    return db.getEventType(id)
  }

  async getEventTypeByName(name: string): Promise<DbEventType | null> {
    return db.getEventTypeByName(name)
  }

  async createEventType(input: { name: string; color: string }): Promise<DbEventType> {
    return db.createEventType(input)
  }

  async deleteEventType(id: string): Promise<void> {
    return db.deleteEventType(id)
  }

  // ── Committee colour settings ─────────────────────────────────────────────

  async getCommitteeCalendarSettings(committeeId: string): Promise<DbCommitteeCalendarSettings | null> {
    return db.getCommitteeCalendarSettings(committeeId)
  }

  async upsertCommitteeCalendarSettings(committeeId: string, color: string): Promise<DbCommitteeCalendarSettings> {
    return db.upsertCommitteeCalendarSettings(committeeId, color)
  }

  // ── CalDAV queue admin reads ───────────────────────────────────────────────

  async listFailedCaldavSync(): Promise<DbCalDavQueueEntry[]> {
    return db.listFailedCaldavSync()
  }
}
