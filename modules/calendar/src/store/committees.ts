// services/calendar/src/store/committees.ts
//
// event_committees + committee_calendar_settings ops on a per-tenant
// postgres-js Sql pool. Ported from
// gremion-ui/src/lib/server/calendar/calendar-db.ts with IDENTICAL semantics.
//
// D6 (thin leaf): committee_id columns here are plain UUIDs, NOT FK'd to a
// committees table (governance-owned, lives in the kernel DB only).

import type { Sql } from '../tenant-store.js'

// ── types ────────────────────────────────────────────────────────────────────

export interface DbCommitteeCalendarSettings {
  committeeId: string
  color: string
  updatedAt: Date
}

// ── committee calendar settings ─────────────────────────────────────────────

export async function getCommitteeCalendarSettings(
  sql: Sql,
  committeeId: string,
): Promise<DbCommitteeCalendarSettings | null> {
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
  sql: Sql,
  committeeId: string,
  color: string,
): Promise<DbCommitteeCalendarSettings> {
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
