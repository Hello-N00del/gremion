// services/newsletter/src/store/lists.ts
//
// Mailing list + member CRUD ops on a per-tenant postgres-js Sql pool.
// Ported from gremion-ui/src/lib/server/newsletter/newsletter-db.ts with
// IDENTICAL semantics; all ops are async (postgres-js returns Promises).

import type { Sql } from '../tenant-store.js'

// ── types ──────────────────────────────────────────────────────────────────────

export interface MailingList {
  id: number
  name: string
  created_at: string
}

export interface MailingListMember {
  id: number
  list_id: number
  email: string
  name: string | null
  source: 'csv' | 'manual'
  created_at: string
}

// ── helpers ────────────────────────────────────────────────────────────────────

/** Map a raw PG row (bigint id comes back as string from postgres-js) to the typed shape. */
function toList(row: Record<string, unknown>): MailingList {
  return {
    id: Number(row['id']),
    name: row['name'] as string,
    created_at: row['created_at'] instanceof Date
      ? row['created_at'].toISOString()
      : String(row['created_at']),
  }
}

function toMember(row: Record<string, unknown>): MailingListMember {
  return {
    id: Number(row['id']),
    list_id: Number(row['list_id']),
    email: row['email'] as string,
    name: row['name'] != null ? String(row['name']) : null,
    source: row['source'] as 'csv' | 'manual',
    created_at: row['created_at'] instanceof Date
      ? row['created_at'].toISOString()
      : String(row['created_at']),
  }
}

// ── ops ────────────────────────────────────────────────────────────────────────

export async function createMailingList(sql: Sql, name: string): Promise<MailingList> {
  const rows = await sql<Record<string, unknown>[]>`
    INSERT INTO mailing_lists (name) VALUES (${name})
    RETURNING id, name, created_at
  `
  return toList(rows[0]!)
}

export async function listMailingLists(sql: Sql): Promise<MailingList[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, name, created_at FROM mailing_lists ORDER BY created_at DESC
  `
  return rows.map(toList)
}

export async function deleteMailingList(sql: Sql, id: number): Promise<void> {
  await sql`DELETE FROM mailing_lists WHERE id = ${id}`
}

export async function addMember(
  sql: Sql,
  listId: number,
  email: string,
  name: string | null,
  source: 'csv' | 'manual',
): Promise<void> {
  await sql`
    INSERT INTO mailing_list_members (list_id, email, name, source)
    VALUES (${listId}, ${email}, ${name}, ${source})
    ON CONFLICT (list_id, email) DO NOTHING
  `
}

export async function listMembers(sql: Sql, listId: number): Promise<MailingListMember[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, list_id, email, name, source, created_at
    FROM mailing_list_members
    WHERE list_id = ${listId}
    ORDER BY email
  `
  return rows.map(toMember)
}

export async function deleteMember(sql: Sql, memberId: number): Promise<void> {
  await sql`DELETE FROM mailing_list_members WHERE id = ${memberId}`
}

/**
 * Total distinct subscriber count across all mailing lists.
 * Counts a member once even if they appear on several lists (DISTINCT email).
 */
export async function countSubscribers(sql: Sql): Promise<number> {
  const rows = await sql<{ c: string }[]>`
    SELECT COUNT(DISTINCT email) AS c FROM mailing_list_members
  `
  return Number(rows[0]!.c)
}
