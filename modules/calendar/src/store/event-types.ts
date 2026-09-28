// services/calendar/src/store/event-types.ts
//
// Event-type CRUD ops on a per-tenant postgres-js Sql pool.
// Ported from gremion-ui/src/lib/server/calendar/calendar-db.ts with IDENTICAL
// semantics.

import type { Sql } from '../tenant-store.js'

// ── types ────────────────────────────────────────────────────────────────────

export interface DbEventType {
  id: string
  name: string
  color: string
  isSystem: boolean
  createdAt: Date
}

// ── helpers ──────────────────────────────────────────────────────────────────

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

// ── ops ──────────────────────────────────────────────────────────────────────

export async function listEventTypes(sql: Sql): Promise<DbEventType[]> {
  const rows = await sql<{
    id: string; name: string; color: string; is_system: boolean; created_at: Date
  }[]>`SELECT * FROM event_types ORDER BY is_system DESC, name`
  return rows.map(mapEventType)
}

export async function getEventType(sql: Sql, id: string): Promise<DbEventType | null> {
  const rows = await sql<{
    id: string; name: string; color: string; is_system: boolean; created_at: Date
  }[]>`SELECT * FROM event_types WHERE id = ${id}`
  return rows[0] ? mapEventType(rows[0]) : null
}

export async function getEventTypeByName(sql: Sql, name: string): Promise<DbEventType | null> {
  const rows = await sql<{
    id: string; name: string; color: string; is_system: boolean; created_at: Date
  }[]>`SELECT * FROM event_types WHERE name = ${name} LIMIT 1`
  return rows[0] ? mapEventType(rows[0]) : null
}

export async function createEventType(
  sql: Sql,
  input: { name: string; color: string },
): Promise<DbEventType> {
  const rows = await sql<{
    id: string; name: string; color: string; is_system: boolean; created_at: Date
  }[]>`
    INSERT INTO event_types (name, color, is_system)
    VALUES (${input.name}, ${input.color}, false)
    RETURNING *
  `
  return mapEventType(rows[0]!)
}

/** Deletes a non-system event type. Throws if system or not found. */
export async function deleteEventType(sql: Sql, id: string): Promise<void> {
  const t = await getEventType(sql, id)
  if (!t) throw new Error('Event type not found')
  if (t.isSystem) throw new Error('Cannot delete system event type')
  await sql`DELETE FROM event_types WHERE id = ${id}`
}
