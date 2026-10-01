// services/calendar/src/store/events.ts
//
// Calendar event CRUD ops on a per-tenant postgres-js Sql pool.
// Ported from gremion-ui/src/lib/server/calendar/calendar-db.ts with IDENTICAL
// semantics (colour computation, CalDAV enqueue side-effects, enrichment).
//
// Cross-domain note (D6 — thin leaf): event_committees.committee_id and
// committee_calendar_settings.committee_id are plain UUID columns here, NOT
// FK'd to a committees table (that table is kernel-only/governance and does
// not exist in this leaf's DB). Referential integrity across the leaf
// boundary is the kernel's responsibility.

import type { Sql } from '../tenant-store.js'
import { computeEventColour, DEFAULT_SHARED_EVENT_COLOR } from './calendar-color.js'
import { deleteRecurrence, getRecurrence, insertRecurrence } from './recurrence.js'
import type { DbRecurrence, RecurrenceFrequency } from './recurrence.js'

export type { DbRecurrence, RecurrenceFrequency }

// ── types ────────────────────────────────────────────────────────────────────

export type EventSource = 'manual' | 'helios' | 'minutes' | 'holiday' | 'newsletter'

export interface DbEvent {
  id: string
  title: string
  description: string | null
  location: string | null
  startAt: Date
  endAt: Date
  allDay: boolean
  /** D-2: only `true` events may ever be pushed to the shared CalDAV calendar. */
  isPublic: boolean
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

// ── helpers ──────────────────────────────────────────────────────────────────

function isReadOnlySource(source: EventSource): boolean {
  return source === 'helios' || source === 'holiday'
}

interface EventRow {
  id: string
  title: string
  description: string | null
  location: string | null
  start_at: Date
  end_at: Date
  all_day: boolean
  is_public: boolean
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

async function enrichEvent(sql: Sql, row: EventRow, sharedEventColor: string): Promise<DbEvent> {
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

  const recurrence = await getRecurrence(sql, row.id)

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
    isPublic: row.is_public === true,
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

// ── event CRUD ───────────────────────────────────────────────────────────────

export async function listEvents(sql: Sql, filter: ListEventsFilter = {}): Promise<DbEvent[]> {
  const from = filter.from ?? new Date(0)
  const to = filter.to ?? new Date('2099-01-01T00:00:00Z')
  const shared = DEFAULT_SHARED_EVENT_COLOR

  // S1c#12 / S5#7: a recurring event is stored ONCE, at its first occurrence, so
  // the plain [start_at, end_at] overlap test made it vanish from every window
  // after that first occurrence. A recurring event whose first occurrence is
  // before the window's end and whose recurrence has not ended before the
  // window's start is therefore returned too (the MASTER row, with its
  // `recurrence` attached; the consumer expands occurrences). COUNT-limited
  // recurrences cannot be bounded in SQL, so they over-include; that is the safe
  // direction (an event shown, never an event lost).
  const committeeClause = filter.committeeId
    ? sql`AND EXISTS (
        SELECT 1 FROM event_committees ec
        WHERE ec.event_id = e.id AND ec.committee_id = ${filter.committeeId}
      )`
    : sql``
  const typeClause = filter.eventTypeId ? sql`AND e.event_type_id = ${filter.eventTypeId}` : sql``

  const rows = await sql<EventRow[]>`
    SELECT e.*, et.color AS event_type_color, et.name AS event_type_name
    FROM calendar_events e
    LEFT JOIN event_types et ON et.id = e.event_type_id
    WHERE (
      (e.end_at >= ${from} AND e.start_at < ${to})
      OR (
        e.start_at < ${to}
        AND EXISTS (
          SELECT 1 FROM event_recurrence r
          WHERE r.event_id = e.id AND (r.until IS NULL OR r.until >= ${from})
        )
      )
    )
    ${committeeClause}
    ${typeClause}
    ORDER BY e.start_at
  `

  return Promise.all(rows.map((r) => enrichEvent(sql, r, shared)))
}

export async function getEvent(sql: Sql, id: string): Promise<DbEvent | null> {
  const rows = await sql<EventRow[]>`
    SELECT e.*, et.color AS event_type_color, et.name AS event_type_name
    FROM calendar_events e
    LEFT JOIN event_types et ON et.id = e.event_type_id
    WHERE e.id = ${id}
  `
  if (!rows[0]) return null
  return enrichEvent(sql, rows[0], DEFAULT_SHARED_EVENT_COLOR)
}

/**
 * Find one event by (source, external_id), or null. Backs the leaf's
 * GET /api/v1/events/by-external route (CalendarBackendPort.findEventByExternalId)
 * — the cross-DB-safe dedup read for the holiday sync. Returns the
 * earliest-created match.
 */
export async function findEventByExternalId(
  sql: Sql,
  source: EventSource,
  externalId: string,
): Promise<DbEvent | null> {
  const rows = await sql<EventRow[]>`
    SELECT e.*, et.color AS event_type_color, et.name AS event_type_name
    FROM calendar_events e
    LEFT JOIN event_types et ON et.id = e.event_type_id
    WHERE e.source = ${source} AND e.external_id = ${externalId}
    ORDER BY e.created_at
    LIMIT 1
  `
  if (!rows[0]) return null
  return enrichEvent(sql, rows[0], DEFAULT_SHARED_EVENT_COLOR)
}

export async function createEvent(sql: Sql, input: CreateEventInput): Promise<DbEvent> {
  const caldavUid = `${crypto.randomUUID()}@stura`

  // B5: holiday events are (source, external_id)-unique via a PARTIAL unique
  // index (migration 003). A concurrent or re-run holiday sync must be a no-op
  // — not a duplicate row, not a crash — so a holiday insert is conflict-tolerant
  // and the existing row is returned unchanged. Other sources have no such index
  // (they legitimately create several rows per external_id), so they keep the
  // plain insert; an ON CONFLICT with no matching arbiter index would error.
  const holidayDedup = input.source === 'holiday' && input.externalId !== null
  const conflictClause = holidayDedup
    ? sql`ON CONFLICT (source, external_id) WHERE source = 'holiday' DO NOTHING`
    : sql``

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
    ${conflictClause}
    RETURNING *, NULL::text AS event_type_color, NULL::text AS event_type_name
  `

  if (rows.length === 0) {
    // Holiday conflict (partial unique index) → no-op: return the existing row
    // without re-enqueuing CalDAV / committees / recurrence side-effects.
    const existing = await findEventByExternalId(sql, 'holiday', input.externalId!)
    if (existing) return existing
    throw new Error(
      'createEvent: holiday (source, external_id) conflict but existing row not found',
    )
  }

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
    await insertRecurrence(sql, id, input.recurrence)
  }

  // Enqueue CalDAV create.
  await sql`
    INSERT INTO caldav_sync_queue (event_id, caldav_uid, operation)
    VALUES (${id}, ${caldavUid}, 'create')
  `

  const reloaded = await getEvent(sql, id)
  if (!reloaded) throw new Error('createEvent: reload failed')
  return reloaded
}

export async function updateEvent(sql: Sql, id: string, input: UpdateEventInput): Promise<DbEvent> {
  // K4#5: description / location / event type are NULLABLE columns, so "key
  // absent" (leave alone) and "key = null" (clear) must be told apart. COALESCE
  // cannot: COALESCE(null, col) is a silent no-op, so a field could never be
  // cleared. Those three use CASE on key presence; the NOT NULL columns keep
  // COALESCE (null there is never a meaningful value).
  await sql`
    UPDATE calendar_events SET
      title              = COALESCE(${input.title ?? null}, title),
      description        = CASE WHEN ${input.description !== undefined} THEN ${input.description ?? null} ELSE description END,
      location           = CASE WHEN ${input.location !== undefined} THEN ${input.location ?? null} ELSE location END,
      start_at           = COALESCE(${input.startAt ?? null}, start_at),
      end_at             = COALESCE(${input.endAt ?? null}, end_at),
      all_day            = COALESCE(${input.allDay ?? null}, all_day),
      is_public          = COALESCE(${input.isPublic ?? null}, is_public),
      event_type_id      = CASE WHEN ${input.eventTypeId !== undefined} THEN ${input.eventTypeId ?? null} ELSE event_type_id END,
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
    await deleteRecurrence(sql, id)
    if (input.recurrence) {
      await insertRecurrence(sql, id, input.recurrence)
    }
  }

  // Enqueue CalDAV update.
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

  const reloaded = await getEvent(sql, id)
  if (!reloaded) throw new Error(`updateEvent: event ${id} vanished`)
  return reloaded
}

/** Deletes event + enqueues CalDAV delete. Returns caldav_uid if it had one. */
export async function deleteEvent(sql: Sql, id: string): Promise<string | null> {
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

/**
 * Bulk-deletes events matching (source, external_id). Used by automation re-sync.
 * Returns the ids of the deleted rows (not just a count) so callers can
 * enqueue a per-event outbox row (e.g. event.deleted with eventDbId) for
 * each deletion, matching the AsyncAPI contract's per-event payload shape.
 */
export async function deleteEventsByExternalId(
  sql: Sql,
  source: EventSource,
  externalId: string,
): Promise<string[]> {
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
  return rows.map((row) => row.id)
}
