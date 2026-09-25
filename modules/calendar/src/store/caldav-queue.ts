// services/calendar/src/store/caldav-queue.ts
//
// caldav_sync_queue drain ops on a per-tenant postgres-js Sql pool.
// Ported from gremion-ui/src/lib/server/calendar/calendar-db.ts with IDENTICAL
// semantics. The leaf now OWNS this queue + its drain (D6 — CalDAV push
// ticker moves to the leaf); markCaldavSynced/listPendingCaldavSync/
// removeCaldavSyncEntry/recordCaldavSyncFailure are drain-internal and are
// intentionally NOT on CalendarBackendPort — only listFailedCaldavSync is.

import type { Sql } from '../tenant-store.js'

// ── types ────────────────────────────────────────────────────────────────────

export type CaldavOperation = 'create' | 'update' | 'delete'

export interface DbCalDavQueueEntry {
  id: string
  eventId: string | null
  caldavUid: string
  operation: CaldavOperation
  attempts: number
  lastError: string | null
  createdAt: Date
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface QueueRow {
  id: string
  event_id: string | null
  caldav_uid: string
  operation: CaldavOperation
  attempts: number
  last_error: string | null
  created_at: Date
}

function mapQueueEntry(r: QueueRow): DbCalDavQueueEntry {
  return {
    id: r.id,
    eventId: r.event_id,
    caldavUid: r.caldav_uid,
    operation: r.operation,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
  }
}

// ── ops ──────────────────────────────────────────────────────────────────────

export async function markCaldavSynced(sql: Sql, eventId: string): Promise<void> {
  await sql`UPDATE calendar_events SET caldav_synced_at = now() WHERE id = ${eventId}`
}

export async function listPendingCaldavSync(
  sql: Sql,
  maxAttempts = 3,
  limit = 50,
): Promise<DbCalDavQueueEntry[]> {
  const rows = await sql<QueueRow[]>`
    SELECT * FROM caldav_sync_queue
    WHERE attempts < ${maxAttempts}
    ORDER BY created_at
    LIMIT ${limit}
  `
  return rows.map(mapQueueEntry)
}

export async function removeCaldavSyncEntry(sql: Sql, id: string): Promise<void> {
  await sql`DELETE FROM caldav_sync_queue WHERE id = ${id}`
}

export async function recordCaldavSyncFailure(sql: Sql, id: string, message: string): Promise<void> {
  await sql`
    UPDATE caldav_sync_queue
    SET attempts = attempts + 1, last_error = ${message}
    WHERE id = ${id}
  `
}

export async function listFailedCaldavSync(
  sql: Sql,
  maxAttempts = 3,
): Promise<DbCalDavQueueEntry[]> {
  const rows = await sql<QueueRow[]>`
    SELECT * FROM caldav_sync_queue
    WHERE attempts >= ${maxAttempts}
    ORDER BY created_at DESC
  `
  return rows.map(mapQueueEntry)
}
