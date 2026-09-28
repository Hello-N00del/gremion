// services/newsletter/src/store/newsletters.ts
//
// Newsletter CRUD + recipients + claim/reset ops on a per-tenant postgres-js Sql pool.
// Ported from gremion-ui/src/lib/server/newsletter/newsletter-db.ts with
// IDENTICAL semantics; all ops are async.

import type { Sql } from '../tenant-store.js'

// ── types ──────────────────────────────────────────────────────────────────────

export interface Newsletter {
  id: number
  title: string
  odt_path: string
  subject: string
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed'
  scheduled_at: string | null
  sent_at: string | null
  error: string | null
  created_by: string
  created_at: string
  /** G-017: bumped by the PG trigger on every UPDATE. */
  updated_at: string
}

export interface NewsletterRecipient {
  newsletter_id: number
  mailing_list_id: number | null
  keycloak_group_id: string | null
}

// ── helpers ────────────────────────────────────────────────────────────────────

function toDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (v == null) return String(v)
  return String(v as string | number)
}

function toNullableDate(v: unknown): string | null {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  return String(v as string | number)
}

function toNewsletter(row: Record<string, unknown>): Newsletter {
  return {
    id: Number(row['id']),
    title: row['title'] as string,
    odt_path: row['odt_path'] as string,
    subject: row['subject'] as string,
    status: row['status'] as Newsletter['status'],
    scheduled_at: toNullableDate(row['scheduled_at']),
    sent_at: toNullableDate(row['sent_at']),
    error: row['error'] != null ? (row['error'] as string) : null,
    created_by: row['created_by'] as string,
    created_at: toDate(row['created_at']),
    updated_at: toDate(row['updated_at']),
  }
}

function toRecipient(row: Record<string, unknown>): NewsletterRecipient {
  return {
    newsletter_id: Number(row['newsletter_id']),
    mailing_list_id: row['mailing_list_id'] != null ? Number(row['mailing_list_id']) : null,
    keycloak_group_id: row['keycloak_group_id'] != null ? (row['keycloak_group_id'] as string) : null,
  }
}

// ── newsletter CRUD ────────────────────────────────────────────────────────────

export async function createNewsletter(
  sql: Sql,
  data: { title: string; odt_path: string; subject: string; created_by: string },
): Promise<Newsletter> {
  const rows = await sql<Record<string, unknown>[]>`
    INSERT INTO newsletters (title, odt_path, subject, created_by)
    VALUES (${data.title}, ${data.odt_path}, ${data.subject}, ${data.created_by})
    RETURNING *
  `
  return toNewsletter(rows[0]!)
}

export async function listNewsletters(sql: Sql): Promise<Newsletter[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM newsletters ORDER BY created_at DESC
  `
  return rows.map(toNewsletter)
}

export async function getNewsletter(sql: Sql, id: number): Promise<Newsletter | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM newsletters WHERE id = ${id}
  `
  return rows.length > 0 ? toNewsletter(rows[0]!) : null
}

/**
 * Partial-update newsletters — mirrors the SQLite updateNewsletter().
 * Only the provided fields are SET. No-op when data is empty.
 */
export async function updateNewsletter(
  sql: Sql,
  id: number,
  data: Partial<Pick<Newsletter, 'subject' | 'status' | 'scheduled_at' | 'sent_at' | 'error'>>,
): Promise<void> {
  const fields = Object.keys(data) as Array<keyof typeof data>
  if (fields.length === 0) return

  // All keys are known-safe Newsletter field names — validated against allowlist.
  const ALLOWED: ReadonlySet<string> = new Set([
    'subject', 'status', 'scheduled_at', 'sent_at', 'error',
  ])
  for (const f of fields) {
    if (!ALLOWED.has(f)) throw new Error(`[newsletter-store] disallowed update field: ${f}`)
  }

  // Build SET clause with positional params ($1, $2, …, $N, $N+1 for id).
  const setClauses = fields.map((f, i) => `"${f}" = $${i + 1}`).join(', ')
  const values: unknown[] = fields.map((f) => data[f] ?? null)
  values.push(id) // id is the last param

  await sql.unsafe(
    `UPDATE newsletters SET ${setClauses} WHERE id = $${values.length}`,
    values as Parameters<typeof sql.unsafe>[1],
  )
}

// ── recipients ─────────────────────────────────────────────────────────────────

export async function setNewsletterRecipients(
  sql: Sql,
  newsletterId: number,
  recipients: Array<{ mailing_list_id?: number; keycloak_group_id?: string }>,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM newsletter_recipients WHERE newsletter_id = ${newsletterId}`
    for (const r of recipients) {
      const listId = r.mailing_list_id ?? null
      const groupId = r.keycloak_group_id ?? null
      await tx`
        INSERT INTO newsletter_recipients (newsletter_id, mailing_list_id, keycloak_group_id)
        VALUES (${newsletterId}, ${listId}, ${groupId})
        ON CONFLICT DO NOTHING
      `
    }
  })
}

export async function getNewsletterRecipients(
  sql: Sql,
  newsletterId: number,
): Promise<NewsletterRecipient[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT newsletter_id, mailing_list_id, keycloak_group_id
    FROM newsletter_recipients
    WHERE newsletter_id = ${newsletterId}
  `
  return rows.map(toRecipient)
}

export async function getScheduledDueNewsletters(sql: Sql): Promise<Newsletter[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM newsletters
    WHERE status = 'scheduled' AND scheduled_at <= now()
  `
  return rows.map(toNewsletter)
}

// ── claim / reset (G-017) ──────────────────────────────────────────────────────

/**
 * Atomically claim a newsletter for sending.
 * Returns true iff the row was transitioned to 'sending' from a status other
 * than 'sending' or 'sent'. One atomic UPDATE … WHERE … RETURNING — no
 * separate SELECT, so two concurrent callers cannot both win.
 */
export async function claimNewsletterForSending(sql: Sql, id: number): Promise<boolean> {
  const rows = await sql<{ id: number }[]>`
    UPDATE newsletters
    SET status = 'sending'
    WHERE id = ${id}
      AND status NOT IN ('sending', 'sent')
    RETURNING id
  `
  return rows.length > 0
}

/**
 * G-017: reset newsletters that have been in 'sending' status longer than
 * `stuckMinutes` minutes (indicating the sender process crashed mid-send).
 * Sets status to 'failed' and returns the number of rows reset.
 * Ports the scheduler's resetStuckSending guard down into the store.
 */
export async function resetStuckSending(sql: Sql, stuckMinutes: number): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    UPDATE newsletters
    SET status = 'failed'
    WHERE status = 'sending'
      AND updated_at < now() - (${stuckMinutes} || ' minutes')::interval
    RETURNING id
  `
  return rows.length
}

// ── counts ─────────────────────────────────────────────────────────────────────

/**
 * Resolved recipient count for one newsletter: distinct member emails reachable
 * through its attached mailing lists. Group recipients (keycloak_group_id) are
 * resolved at send-time, not counted here.
 */
export async function countNewsletterRecipients(sql: Sql, newsletterId: number): Promise<number> {
  const rows = await sql<{ c: string }[]>`
    SELECT COUNT(DISTINCT m.email) AS c
    FROM newsletter_recipients r
    JOIN mailing_list_members m ON m.list_id = r.mailing_list_id
    WHERE r.newsletter_id = ${newsletterId}
      AND r.mailing_list_id IS NOT NULL
  `
  return Number(rows[0]!.c)
}
