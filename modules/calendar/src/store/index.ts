// services/calendar/src/store/index.ts
//
// Barrel re-export of all per-tenant PG store ops for the calendar leaf.
// Import from here rather than from individual modules.

export type {
  DbEvent,
  CreateEventInput,
  UpdateEventInput,
  ListEventsFilter,
  EventSource,
} from './events.js'
export {
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  deleteEventsByExternalId,
  findEventByExternalId,
} from './events.js'

export type { DbEventType } from './event-types.js'
export {
  listEventTypes,
  getEventType,
  getEventTypeByName,
  createEventType,
  deleteEventType,
} from './event-types.js'

export type { DbRecurrence, RecurrenceFrequency } from './recurrence.js'
export { insertRecurrence, deleteRecurrence, getRecurrence } from './recurrence.js'

export type { DbCommitteeCalendarSettings } from './committees.js'
export { getCommitteeCalendarSettings, upsertCommitteeCalendarSettings } from './committees.js'

export type { DbCalDavQueueEntry, CaldavOperation } from './caldav-queue.js'
export {
  markCaldavSynced,
  listPendingCaldavSync,
  removeCaldavSyncEntry,
  recordCaldavSyncFailure,
  listFailedCaldavSync,
} from './caldav-queue.js'

export { recordCalendarAudit } from './audit.js'
