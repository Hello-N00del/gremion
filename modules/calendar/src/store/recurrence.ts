// services/calendar/src/store/recurrence.ts
//
// event_recurrence helpers used by createEvent/updateEvent (events.ts).
// Ported from the recurrence-handling inline in
// gremion-ui/src/lib/server/calendar/calendar-db.ts's createEvent/updateEvent.

import type { Sql } from '../tenant-store.js'

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly'

export interface DbRecurrence {
  frequency: RecurrenceFrequency
  interval: number
  until: Date | null
  count: number | null
  byday: string[] | null
  exceptions: Date[] | null
}

/** Insert one event_recurrence row for the given event. */
export async function insertRecurrence(sql: Sql, eventId: string, r: DbRecurrence): Promise<void> {
  await sql`
    INSERT INTO event_recurrence (event_id, frequency, interval, until, count, byday, exceptions)
    VALUES (
      ${eventId}, ${r.frequency}, ${r.interval},
      ${r.until}, ${r.count},
      ${r.byday as string[] | null},
      ${r.exceptions as Date[] | null}
    )
  `
}

/** Delete the event_recurrence row for the given event (no-op if none). */
export async function deleteRecurrence(sql: Sql, eventId: string): Promise<void> {
  await sql`DELETE FROM event_recurrence WHERE event_id = ${eventId}`
}

/** Fetch the event_recurrence row for the given event, or null. */
export async function getRecurrence(sql: Sql, eventId: string): Promise<DbRecurrence | null> {
  const rows = await sql<{
    frequency: string
    interval: number
    until: Date | null
    count: number | null
    byday: string[] | null
    exceptions: Date[] | null
  }[]>`
    SELECT frequency, interval, until, count, byday, exceptions
    FROM event_recurrence WHERE event_id = ${eventId}
  `
  return rows[0]
    ? {
        frequency: rows[0].frequency as RecurrenceFrequency,
        interval: rows[0].interval,
        until: rows[0].until,
        count: rows[0].count,
        byday: rows[0].byday,
        exceptions: rows[0].exceptions,
      }
    : null
}
