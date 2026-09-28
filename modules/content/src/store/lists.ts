// services/content/src/store/lists.ts
//
// Mailing list + member CRUD ops on a per-tenant postgres-js Sql pool.
// Mirrors services/newsletter/src/store/lists.ts adapted for the content
// schema (UUID PKs, content.mailing_lists, content.mailing_list_members).

import type { Sql } from '../tenant-store.js'

// ── types ──────────────────────────────────────────────────────────────────────

export interface MailingList {
  id: string       // UUID
  name: string
  created_at: string
}

export interface MailingListMember {
  id: string       // UUID
  mailing_list_id: string
  email: string
  name: string | null
  source: 'csv' | 'manual'
  created_at: string
}

// ── helpers ────────────────────────────────────────────────────────────────────

function toList(row: Record<string, unknown>): MailingList {
  return {
    id: String(row['id']),
    name: row['name'] as string,
    created_at: row['created_at'] instanceof Date
      ? row['created_at'].toISOString()
      : String(row['created_at']),
  }
}

function toMember(row: Record<string, unknown>): MailingListMember {
  return {
    id: String(row['id']),
    mailing_list_id: String(row['mailing_list_id']),
    email: row['email'] as string,
    name: row['name'] != null ? (row['name'] as string) : null,
    source: row['source'] as 'csv' | 'manual',
    created_at: row['created_at'] instanceof Date
      ? row['created_at'].toISOString()
      : String(row['created_at']),
  }
}

// ── ops ────────────────────────────────────────────────────────────────────────

export async function createMailingList(sql: Sql, name: string): Promise<MailingList> {
  const rows = await sql<Record<string, unknown>[]>`
    INSERT INTO content.mailing_lists (name) VALUES (${name})
    RETURNING id, name, created_at
  `
  return toList(rows[0]!)
}

export async function listMailingLists(sql: Sql): Promise<MailingList[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, name, created_at FROM content.mailing_lists ORDER BY created_at DESC
  `
  return rows.map(toList)
}

export async function deleteMailingList(sql: Sql, id: string): Promise<void> {
  await sql`DELETE FROM content.mailing_lists WHERE id = ${id}`
}

export async function addListMember(
  sql: Sql,
  mailingListId: string,
  email: string,
  name: string | null,
  source: 'csv' | 'manual',
): Promise<void> {
  await sql`
    INSERT INTO content.mailing_list_members (mailing_list_id, email, name, source)
    VALUES (${mailingListId}, ${email}, ${name}, ${source})
    ON CONFLICT (mailing_list_id, email) DO NOTHING
  `
}

export async function listMembers(sql: Sql, mailingListId: string): Promise<MailingListMember[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, mailing_list_id, email, name, source, created_at
    FROM content.mailing_list_members
    WHERE mailing_list_id = ${mailingListId}
    ORDER BY email
  `
  return rows.map(toMember)
}

export async function removeListMember(sql: Sql, memberId: string): Promise<void> {
  await sql`DELETE FROM content.mailing_list_members WHERE id = ${memberId}`
}
