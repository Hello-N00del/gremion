// Calendar DB access layer — Stream B1.
// `stura` Postgres is the source of truth. CalDAV is push-only (enqueued here,
// drained by caldav-sync.ts). Every read returns an enriched DbEvent with a
// computed `{ primary, secondary }` colour pair.

import { getDb } from '../db'
import {
  computeEventColour,
  DEFAULT_SHARED_EVENT_COLOR,
} from './calendar-color'
import { readConfig } from '../config'

// ─── Types ────────────────────────────────────────────────────────────────────

export type EventSource = 'manual' | 'helios' | 'minutes' | 'holiday' | 'newsletter'
export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly'
export type CaldavOperation = 'create' | 'update' | 'delete'

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isReadOnlySource(source: EventSource): boolean {
  return source === 'helios' || source === 'holiday'
}

function getSharedEventColor(): string {
  try {
    const cfg = readConfig() as unknown as {
      calendar?: { shared_event_color?: string }
    }
    return cfg.calendar?.shared_event_color ?? DEFAULT_SHARED_EVENT_COLOR
  } catch {
    return DEFAULT_SHARED_EVENT_COLOR
  }
}

interface EventRow {
  id: string
  title: string
  description: string | null
  location: string | null
  start_at: Date
  end_at: Date
  all_day: boolean
  event_type_id: string | null
  event_type_color: string | null
  event_type_name: string | null
  is_multi_committee: boolean
  created_by: string
  source: EventSource
  external_id: string | null
  caldav_uid: string | null
  caldav_synced_at: Date | null
  created_at: Date
  updated_at: Date
}

async function enrichEvent(row: EventRow, sharedEventColor: string): Promise<DbEvent> {
  const sql = getDb()

  const committeeRows = await sql<{ committee_id: string }[]>`
    SELECT committee_id FROM event_committees WHERE event_id = ${row.id}
  `
  const committeeIds = committeeRows.map((r) => r.committee_id)

  let committeeColor: string | null = null
  if (committeeIds.length === 1) {
    const settingsRows = await sql<{ color: string }[]>`
      SELECT color FROM committee_calendar_settings WHERE committee_id = ${committeeIds[0]}
    `
    committeeColor = settingsRows[0]?.color ?? null
  }

  const recRows = await sql<{
    frequency: string
    interval: number
    until: Date | null
    count: number | null
    byday: string[] | null
    exceptions: Date[] | null
  }[]>`
    SELECT frequency, interval, until, count, byday, exceptions
    FROM event_recurrence WHERE event_id = ${row.id}
  `
  const recurrence: DbRecurrence | null = recRows[0]
    ? {
        frequency: recRows[0].frequency as RecurrenceFrequency,
        interval: recRows[0].interval,
        until: recRows[0].until,
        count: recRows[0].count,
        byday: recRows[0].byday,
        exceptions: recRows[0].exceptions,
      }
    : null

  const colour = computeEventColour({
    isMultiCommittee: row.is_multi_committee,
    hasCommittee: committeeIds.length > 0,
    committeeColor,
    eventTypeColor: row.event_type_color,
    sharedEventColor,
  })

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    location: row.location,
    startAt: row.start_at,
    endAt: row.end_at,
    allDay: row.all_day,
    eventTypeId: row.event_type_id,
    eventTypeColor: row.event_type_color,
    eventTypeName: row.event_type_name,
    isMultiCommittee: row.is_multi_committee,
    createdBy: row.created_by,
    source: row.source,
    externalId: row.external_id,
    caldavUid: row.caldav_uid,
    caldavSyncedAt: row.caldav_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    committeeIds,
    recurrence,
    colour,
    readOnly: isReadOnlySource(row.source),
  }
}

// ─── Event CRUD ───────────────────────────────────────────────────────────────

export async function listEvents(filter: ListEventsFilter = {}): Promise<DbEvent[]> {
  const sql = getDb()
  const from = filter.from ?? new Date(0)
  const to = filter.to ?? new Date('2099-01-01T00:00:00Z')
  const shared = getSharedEventColor()

  // F1-FIX-08 (S1c#12): a recurring master whose series is still running is
  // part of every later window; callers expand it (recurrence-expand.ts).
  const inWindow = sql`(
    (e.end_at >= ${from} AND e.start_at < ${to})
    OR (e.start_at < ${to} AND EXISTS (
      SELECT 1 FROM event_recurrence r
      WHERE r.event_id = e.id AND (r.until IS NULL OR r.until >= ${from})
    ))
  )`

  let rows: EventRow[]
  if (filter.committeeId && filter.eventTypeId) {
    rows = await sql<EventRow[]>`
      SELECT e.*, et.color AS event_type_color, et.name AS event_type_name
      FROM calendar_events e
      LEFT JOIN event_types et ON et.id = e.event_type_id
      JOIN event_committees ec ON ec.event_id = e.id
      WHERE ec.committee_id = ${filter.committeeId}
        AND e.event_type_id = ${filter.eventTypeId}
        AND ${inWindow}
      ORDER BY e.start_at
    `
  } else if (filter.committeeId) {
    rows = await sql<EventRow[]>`
      SELECT e.*, et.color AS event_type_color, et.name AS event_type_name
      FROM calendar_events e
      LEFT JOIN event_types et ON et.id = e.event_type_id
      JOIN event_committees ec ON ec.event_id = e.id
      WHERE ec.committee_id = ${filter.committeeId}
        AND ${inWindow}
      ORDER BY e.start_at
    `
  } else if (filter.eventTypeId) {
    rows = await sql<EventRow[]>`
      SELECT e.*, et.color AS event_type_color, et.name AS event_type_name
      FROM calendar_events e
      LEFT JOIN event_types et ON et.id = e.event_type_id
      WHERE e.event_type_id = ${filter.eventTypeId}
        AND ${inWindow}
      ORDER BY e.start_at
    `
  } else {
    rows = await sql<EventRow[]>`
      SELECT e.*, et.color AS event_type_color, et.name AS event_type_name
      FROM calendar_events e
      LEFT JOIN event_types et ON et.id = e.event_type_id
      WHERE ${inWindow}
      ORDER BY e.start_at
    `
  }

  return Promise.all(rows.map((r) => enrichEvent(r, shared)))
}

export async function getEvent(id: string): Promise<DbEvent | null> {
  const sql = getDb()
  const rows = await sql<EventRow[]>`
    SELECT e.*, et.color AS event_type_color, et.name AS event_type_name
    FROM calendar_events e
    LEFT JOIN event_types et ON et.id = e.event_type_id
    WHERE e.id = ${id}
  `
  if (!rows[0]) return null
  return enrichEvent(rows[0], getSharedEventColor())
}

/**
 * Find one event by (source, external_id), or null. Backs
 * CalendarBackendPort.findEventByExternalId — the cross-DB-safe dedup read used
 * by the automations (holiday sync). Returns the earliest-created match.
 */
export async function findEventByExternalId(
  source: EventSource,
  externalId: string
): Promise<DbEvent | null> {
  const sql = getDb()
  const rows = await sql<EventRow[]>`
    SELECT e.*, et.color AS event_type_color, et.name AS event_type_name
    FROM calendar_events e
    LEFT JOIN event_types et ON et.id = e.event_type_id
    WHERE e.source = ${source} AND e.external_id = ${externalId}
    ORDER BY e.created_at
    LIMIT 1
  `
  if (!rows[0]) return null
  return enrichEvent(rows[0], getSharedEventColor())
}

export async function createEvent(input: CreateEventInput): Promise<DbEvent> {
  const sql = getDb()
  const caldavUid = `${crypto.randomUUID()}@stura`

  const rows = await sql<EventRow[]>`
    INSERT INTO calendar_events (
      title, description, location, start_at, end_at, all_day,
      is_public, event_type_id, is_multi_committee, created_by, source, external_id, caldav_uid
    ) VALUES (
      ${input.title}, ${input.description}, ${input.location},
      ${input.startAt}, ${input.endAt}, ${input.allDay},
      ${input.isPublic ?? false}, ${input.eventTypeId}, ${input.isMultiCommittee},
      ${input.createdBy}, ${input.source}, ${input.externalId}, ${caldavUid}
    )
    RETURNING *, NULL::text AS event_type_color, NULL::text AS event_type_name
  `
  const created = rows[0]!
  const id = created.id

  if (input.committeeIds.length > 0) {
    await sql`
      INSERT INTO event_committees (event_id, committee_id)
      SELECT ${id}, UNNEST(${input.committeeIds}::uuid[])
      ON CONFLICT DO NOTHING
    `
  }

  if (input.recurrence) {
    const r = input.recurrence
    await sql`
      INSERT INTO event_recurrence (event_id, frequency, interval, until, count, byday, exceptions)
      VALUES (
        ${id}, ${r.frequency}, ${r.interval},
        ${r.until}, ${r.count},
        ${r.byday as string[] | null},
        ${r.exceptions as Date[] | null}
      )
    `
  }

  // Enqueue CalDAV create
  await sql`
    INSERT INTO caldav_sync_queue (event_id, caldav_uid, operation)
    VALUES (${id}, ${caldavUid}, 'create')
  `

  const reloaded = await getEvent(id)
  if (!reloaded) throw new Error('createEvent: reload failed')
  return reloaded
}

export async function updateEvent(id: string, input: UpdateEventInput): Promise<DbEvent> {
  const sql = getDb()

  // F1-FIX-08 (S1c#10, twin of the leaf S4#11 fix): the nullable columns
  // distinguish an explicit null (clear) from an absent key (keep).
  const hasDescription = input.description !== undefined
  const hasLocation = input.location !== undefined
  const hasEventTypeId = input.eventTypeId !== undefined
  await sql`
    UPDATE calendar_events SET
      title              = COALESCE(${input.title ?? null}, title),
      description        = CASE WHEN ${hasDescription}::boolean THEN ${input.description ?? null}::text ELSE description END,
      location           = CASE WHEN ${hasLocation}::boolean THEN ${input.location ?? null}::text ELSE location END,
      start_at           = COALESCE(${input.startAt ?? null}, start_at),
      end_at             = COALESCE(${input.endAt ?? null}, end_at),
      all_day            = COALESCE(${input.allDay ?? null}, all_day),
      is_public          = COALESCE(${input.isPublic ?? null}, is_public),
      event_type_id      = CASE WHEN ${hasEventTypeId}::boolean THEN ${input.eventTypeId ?? null}::uuid ELSE event_type_id END,
      is_multi_committee = COALESCE(${input.isMultiCommittee ?? null}, is_multi_committee),
      updated_at         = now()
    WHERE id = ${id}
  `

  if (input.committeeIds !== undefined) {
    await sql`DELETE FROM event_committees WHERE event_id = ${id}`
    if (input.committeeIds.length > 0) {
      await sql`
        INSERT INTO event_committees (event_id, committee_id)
        SELECT ${id}, UNNEST(${input.committeeIds}::uuid[])
        ON CONFLICT DO NOTHING
      `
    }
  }

  if (input.recurrence !== undefined) {
    await sql`DELETE FROM event_recurrence WHERE event_id = ${id}`
    if (input.recurrence) {
      const r = input.recurrence
      await sql`
        INSERT INTO event_recurrence (event_id, frequency, interval, until, count, byday, exceptions)
        VALUES (
          ${id}, ${r.frequency}, ${r.interval},
          ${r.until}, ${r.count},
          ${r.byday as string[] | null},
          ${r.exceptions as Date[] | null}
        )
      `
    }
  }

  // Enqueue CalDAV update
  const uidRows = await sql<{ caldav_uid: string | null }[]>`
    SELECT caldav_uid FROM calendar_events WHERE id = ${id}
  `
  const caldavUid = uidRows[0]?.caldav_uid ?? null
  if (caldavUid) {
    await sql`
      INSERT INTO caldav_sync_queue (event_id, caldav_uid, operation)
      VALUES (${id}, ${caldavUid}, 'update')
    `
  }

  const reloaded = await getEvent(id)
  if (!reloaded) throw new Error(`updateEvent: event ${id} vanished`)
  return reloaded
}

/** Deletes event + enqueues CalDAV delete. Returns caldav_uid if it had one. */
export async function deleteEvent(id: string): Promise<string | null> {
  const sql = getDb()

  const uidRows = await sql<{ caldav_uid: string | null }[]>`
    SELECT caldav_uid FROM calendar_events WHERE id = ${id}
  `
  const caldavUid = uidRows[0]?.caldav_uid ?? null

  // Enqueue delete FIRST so caldav_uid survives event row removal.
  if (caldavUid) {
    await sql`
      INSERT INTO caldav_sync_queue (event_id, caldav_uid, operation)
      VALUES (${id}, ${caldavUid}, 'delete')
    `
  }

  await sql`DELETE FROM calendar_events WHERE id = ${id}`
  return caldavUid
}

/** Bulk-deletes events matching (source, external_id). Used by automation re-sync. */
export async function deleteEventsByExternalId(
  source: EventSource,
  externalId: string
): Promise<number> {
  const sql = getDb()
  const rows = await sql<{ id: string; caldav_uid: string | null }[]>`
    SELECT id, caldav_uid FROM calendar_events
    WHERE source = ${source} AND external_id = ${externalId}
  `
  for (const row of rows) {
    if (row.caldav_uid) {
      await sql`
        INSERT INTO caldav_sync_queue (event_id, caldav_uid, operation)
        VALUES (${row.id}, ${row.caldav_uid}, 'delete')
      `
    }
  }
  await sql`
    DELETE FROM calendar_events
    WHERE source = ${source} AND external_id = ${externalId}
  `
  return rows.length
}

export async function markCaldavSynced(eventId: string): Promise<void> {
  const sql = getDb()
  await sql`UPDATE calendar_events SET caldav_synced_at = now() WHERE id = ${eventId}`
}

/** F1-FIX-08 (D-2): the event's copy was removed from the shared calendar. */
export async function markCaldavUnsynced(eventId: string): Promise<void> {
  const sql = getDb()
  await sql`UPDATE calendar_events SET caldav_synced_at = NULL WHERE id = ${eventId}`
}

/**
 * F1-FIX-08 (D-2, R29-I15): the CalDAV drain's visibility gate — the event's
 * is_public flag, or null when the row is gone. Kept off DbEvent so the API
 * payload and the CalendarBackendPort DTO stay unchanged.
 */
export async function getEventPublicFlag(eventId: string): Promise<boolean | null> {
  const sql = getDb()
  const rows = await sql<{ is_public: boolean }[]>`
    SELECT is_public FROM calendar_events WHERE id = ${eventId}
  `
  return rows[0] ? rows[0].is_public === true : null
}

/**
 * F1-FIX-08 round 2 (D-2 cleanup, in-process twin of the leaf's
 * services/calendar/migrations/004_caldav_unpublish_private.sql): queue an
 * 'update' row for every non-public event an earlier push left in the shared
 * calendar (caldav_synced_at set). The drain turns it into a DELETE and clears
 * caldav_synced_at, so the event stops matching. Idempotent, so the drain runs
 * it every tick (the gremion-ui schema is not this unit's to migrate). Unlike
 * the once-per-boot leaf migration, NOT EXISTS matches ANY queued update row
 * for the event, dead-lettered ones included: a DELETE that keeps failing
 * stays one row in the admin failure list instead of one more row per tick.
 * Returns the rows queued.
 */
export async function enqueuePrivateCaldavCleanup(): Promise<number> {
  const sql = getDb()
  const rows = await sql<{ id: string }[]>`
    INSERT INTO caldav_sync_queue (event_id, caldav_uid, operation)
    SELECT e.id, e.caldav_uid, 'update'
    FROM calendar_events e
    WHERE e.is_public = false
      AND e.caldav_uid IS NOT NULL
      AND e.caldav_synced_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM caldav_sync_queue q
        WHERE q.event_id = e.id
          AND q.operation = 'update'
      )
    RETURNING id
  `
  return rows.length
}

// ─── Event types ──────────────────────────────────────────────────────────────

function mapEventType(row: {
  id: string
  name: string
  color: string
  is_system: boolean
  created_at: Date
}): DbEventType {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    isSystem: row.is_system,
    createdAt: row.created_at,
  }
}

export async function listEventTypes(): Promise<DbEventType[]> {
  const sql = getDb()
  const rows = await sql<{
    id: string; name: string; color: string; is_system: boolean; created_at: Date
  }[]>`SELECT * FROM event_types ORDER BY is_system DESC, name`
  return rows.map(mapEventType)
}

export async function getEventType(id: string): Promise<DbEventType | null> {
  const sql = getDb()
  const rows = await sql<{
    id: string; name: string; color: string; is_system: boolean; created_at: Date
  }[]>`SELECT * FROM event_types WHERE id = ${id}`
  return rows[0] ? mapEventType(rows[0]) : null
}

export async function getEventTypeByName(name: string): Promise<DbEventType | null> {
  const sql = getDb()
  const rows = await sql<{
    id: string; name: string; color: string; is_system: boolean; created_at: Date
  }[]>`SELECT * FROM event_types WHERE name = ${name} LIMIT 1`
  return rows[0] ? mapEventType(rows[0]) : null
}

export async function createEventType(input: {
  name: string
  color: string
}): Promise<DbEventType> {
  const sql = getDb()
  const rows = await sql<{
    id: string; name: string; color: string; is_system: boolean; created_at: Date
  }[]>`
    INSERT INTO event_types (name, color, is_system)
    VALUES (${input.name}, ${input.color}, false)
    RETURNING *
  `
  return mapEventType(rows[0]!)
}

/** Deletes a non-system event type. Throws if system or in use. */
export async function deleteEventType(id: string): Promise<void> {
  const sql = getDb()
  const t = await getEventType(id)
  if (!t) throw new Error('Event type not found')
  if (t.isSystem) throw new Error('Cannot delete system event type')
  await sql`DELETE FROM event_types WHERE id = ${id}`
}

// ─── Committee calendar settings ──────────────────────────────────────────────

export async function getCommitteeCalendarSettings(
  committeeId: string
): Promise<DbCommitteeCalendarSettings | null> {
  const sql = getDb()
  const rows = await sql<{
    committee_id: string; color: string; updated_at: Date
  }[]>`SELECT * FROM committee_calendar_settings WHERE committee_id = ${committeeId}`
  if (!rows[0]) return null
  return {
    committeeId: rows[0].committee_id,
    color: rows[0].color,
    updatedAt: rows[0].updated_at,
  }
}

export async function upsertCommitteeCalendarSettings(
  committeeId: string,
  color: string
): Promise<DbCommitteeCalendarSettings> {
  const sql = getDb()
  const rows = await sql<{
    committee_id: string; color: string; updated_at: Date
  }[]>`
    INSERT INTO committee_calendar_settings (committee_id, color, updated_at)
    VALUES (${committeeId}, ${color}, now())
    ON CONFLICT (committee_id) DO UPDATE SET
      color = EXCLUDED.color,
      updated_at = now()
    RETURNING *
  `
  return {
    committeeId: rows[0]!.committee_id,
    color: rows[0]!.color,
    updatedAt: rows[0]!.updated_at,
  }
}

// ─── CalDAV sync queue ────────────────────────────────────────────────────────

export async function listPendingCaldavSync(
  maxAttempts = 3,
  limit = 50
): Promise<DbCalDavQueueEntry[]> {
  const sql = getDb()
  const rows = await sql<{
    id: string
    event_id: string | null
    caldav_uid: string
    operation: CaldavOperation
    attempts: number
    last_error: string | null
    created_at: Date
  }[]>`
    SELECT * FROM caldav_sync_queue
    WHERE attempts < ${maxAttempts}
    ORDER BY created_at
    LIMIT ${limit}
  `
  return rows.map((r) => ({
    id: r.id,
    eventId: r.event_id,
    caldavUid: r.caldav_uid,
    operation: r.operation,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
  }))
}

export async function removeCaldavSyncEntry(id: string): Promise<void> {
  const sql = getDb()
  await sql`DELETE FROM caldav_sync_queue WHERE id = ${id}`
}

export async function recordCaldavSyncFailure(
  id: string,
  message: string
): Promise<void> {
  const sql = getDb()
  await sql`
    UPDATE caldav_sync_queue
    SET attempts = attempts + 1, last_error = ${message}
    WHERE id = ${id}
  `
}

export async function listFailedCaldavSync(
  maxAttempts = 3
): Promise<DbCalDavQueueEntry[]> {
  const sql = getDb()
  const rows = await sql<{
    id: string
    event_id: string | null
    caldav_uid: string
    operation: CaldavOperation
    attempts: number
    last_error: string | null
    created_at: Date
  }[]>`
    SELECT * FROM caldav_sync_queue
    WHERE attempts >= ${maxAttempts}
    ORDER BY created_at DESC
  `
  return rows.map((r) => ({
    id: r.id,
    eventId: r.event_id,
    caldavUid: r.caldav_uid,
    operation: r.operation,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
  }))
}

// ─── Imported calendars (holidays) ────────────────────────────────────────────

export interface DbImportedCalendar {
  id: string
  name: string
  sourceUrl: string
  eventTypeId: string | null
  lastSyncedAt: Date | null
  syncIntervalHours: number
}

export async function listImportedCalendars(): Promise<DbImportedCalendar[]> {
  const sql = getDb()
  const rows = await sql<{
    id: string
    name: string
    source_url: string
    event_type_id: string | null
    last_synced_at: Date | null
    sync_interval_hours: number
  }[]>`SELECT * FROM imported_calendars ORDER BY name`
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sourceUrl: r.source_url,
    eventTypeId: r.event_type_id,
    lastSyncedAt: r.last_synced_at,
    syncIntervalHours: r.sync_interval_hours,
  }))
}

export async function markImportedCalendarSynced(id: string): Promise<void> {
  const sql = getDb()
  await sql`UPDATE imported_calendars SET last_synced_at = now() WHERE id = ${id}`
}
