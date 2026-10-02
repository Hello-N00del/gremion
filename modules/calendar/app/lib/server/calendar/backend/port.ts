// gremion-ui/src/lib/server/calendar/backend/port.ts
// Task 1 — branch-by-abstraction seam.
//
// CalendarBackendPort is the interface every consumer of the calendar subsystem
// calls once the seam is wired in (Tasks 3–6 and the leaf routes in Group 4).
// The method set is derived by enumerating every calendar-db / calendar-color
// function the ~11 caller files + calendar-automations.ts + the
// calendar:upcoming-events data-provider actually import/call.
//
// The domain DTO types are lifted verbatim from calendar-db.ts (lines 19–105).
// After Task 6 completes the leaf extraction, callers import only from this seam;
// calendar-db.ts remains the in-process implementation that InprocessCalendarClient
// delegates to.
//
// This file has NO runtime dependencies — it is a pure TypeScript interface.
// DO NOT import from any server module here.

// ── Domain union types ────────────────────────────────────────────────────────

export type EventSource = 'manual' | 'helios' | 'minutes' | 'holiday' | 'newsletter'
export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly'
export type CaldavOperation = 'create' | 'update' | 'delete'

// ── Domain transfer types (lifted verbatim from calendar-db.ts lines 19–105) ─

export interface DbEventType {
  id: string
  name: string
  color: string
  isSystem: boolean
  createdAt: Date
}

export interface DbRecurrence {
  frequency: RecurrenceFrequency
  interval: number
  until: Date | null
  count: number | null
  byday: string[] | null
  exceptions: Date[] | null
}

export interface DbEvent {
  id: string
  title: string
  description: string | null
  location: string | null
  startAt: Date
  endAt: Date
  allDay: boolean
  eventTypeId: string | null
  eventTypeColor: string | null
  eventTypeName: string | null
  isMultiCommittee: boolean
  createdBy: string
  source: EventSource
  externalId: string | null
  caldavUid: string | null
  caldavSyncedAt: Date | null
  createdAt: Date
  updatedAt: Date
  committeeIds: string[]
  recurrence: DbRecurrence | null
  colour: { primary: string; secondary: string }
  readOnly: boolean
}

export interface CreateEventInput {
  title: string
  description: string | null
  location: string | null
  startAt: Date
  endAt: Date
  allDay: boolean
  isPublic?: boolean
  eventTypeId: string | null
  isMultiCommittee: boolean
  createdBy: string
  source: EventSource
  externalId: string | null
  committeeIds: string[]
  recurrence: DbRecurrence | null
}

export interface UpdateEventInput {
  title?: string
  description?: string | null
  location?: string | null
  startAt?: Date
  endAt?: Date
  allDay?: boolean
  isPublic?: boolean
  eventTypeId?: string | null
  isMultiCommittee?: boolean
  committeeIds?: string[]
  recurrence?: DbRecurrence | null
}

export interface ListEventsFilter {
  from?: Date
  to?: Date
  committeeId?: string
  eventTypeId?: string
}

export interface DbCommitteeCalendarSettings {
  committeeId: string
  color: string
  updatedAt: Date
}

export interface DbCalDavQueueEntry {
  id: string
  eventId: string | null
  caldavUid: string
  operation: CaldavOperation
  attempts: number
  lastError: string | null
  createdAt: Date
}

// ── Port interface ────────────────────────────────────────────────────────────

export interface CalendarBackendPort {
  /**
   * Discriminant identifying which implementation is in use.
   * 'inprocess' = in-process DB calls (byte-identical to the monolith);
   * 'service' = HTTP calls to the calendar-service leaf.
   */
  readonly kind: 'inprocess' | 'service'

  // ── Events ────────────────────────────────────────────────────────────────
  listEvents(filter?: ListEventsFilter): Promise<DbEvent[]>
  getEvent(id: string): Promise<DbEvent | null>
  createEvent(input: CreateEventInput): Promise<DbEvent>
  updateEvent(id: string, input: UpdateEventInput): Promise<DbEvent>
  /** Deletes event + enqueues CalDAV delete. Returns caldav_uid if it had one. */
  deleteEvent(id: string): Promise<string | null>
  /** Bulk-deletes events matching (source, externalId). Used by automation re-sync. */
  deleteEventsByExternalId(source: EventSource, externalId: string): Promise<void>
  /**
   * Find one event by (source, externalId), or null when none exists.
   *
   * Used by the automations (e.g. the holiday sync) to dedup against the SAME
   * backend that createEvent writes to. Reading the kernel DB directly (getDb)
   * is cross-DB-WRONG under CALENDAR_BACKEND=service — the leaf owns the data
   * plane there — so dedup MUST go through this port method.
   */
  findEventByExternalId(source: EventSource, externalId: string): Promise<DbEvent | null>

  // ── Event types ────────────────────────────────────────────────────────────
  listEventTypes(): Promise<DbEventType[]>
  getEventType(id: string): Promise<DbEventType | null>
  getEventTypeByName(name: string): Promise<DbEventType | null>
  createEventType(input: { name: string; color: string }): Promise<DbEventType>
  /** Deletes a non-system event type. Throws if system or in use. */
  deleteEventType(id: string): Promise<void>

  // ── Committee colour settings ──────────────────────────────────────────────
  getCommitteeCalendarSettings(committeeId: string): Promise<DbCommitteeCalendarSettings | null>
  upsertCommitteeCalendarSettings(committeeId: string, color: string): Promise<DbCommitteeCalendarSettings>

  // ── CalDAV queue admin reads (drain lives in the leaf) ────────────────────
  /**
   * Returns queue entries that have exhausted their retry budget.
   * The drain itself (listPendingCaldavSync / removeCaldavSyncEntry /
   * recordCaldavSyncFailure / markCaldavSynced) is internal to the leaf and
   * is NOT on this port.
   */
  listFailedCaldavSync(): Promise<DbCalDavQueueEntry[]>
}
