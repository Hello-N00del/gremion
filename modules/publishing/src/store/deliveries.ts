// services/newsletter/src/store/deliveries.ts
//
// D-P1-5 / Task 6: per-recipient deliveries ledger — THE duplicate-send gate (DoD-c).
//
// API:
//   claimRecipient(pool, newsletterId, emailLower) → 'fresh' | 'already-sent' | 'in-flight'
//   markSent(pool, newsletterId, emailLower, messageId) → void
//
// Semantics:
//   - 'fresh':        caller may send (INSERT succeeded or stale-takeover succeeded).
//   - 'in-flight':    a non-stale 'claimed' row exists; another worker is sending — skip.
//   - 'already-sent': a 'sent' row exists; do NOT re-send.
//
// Stale-claim takeover (STALE_CLAIM_MINUTES = 15):
//   A 'claimed' row whose claimed_at is older than 15 minutes is assumed to belong
//   to a crashed sender. We reclaim it atomically via:
//     UPDATE deliveries
//       SET claimed_at = now()
//     WHERE newsletter_id = $1 AND email = $2
//       AND status = 'claimed'
//       AND claimed_at < now() - interval '15 minutes'
//     RETURNING id
//   Only one concurrent caller wins the RETURNING row; the other gets 0 rows and
//   then sees a freshly-claimed (non-stale) row → 'in-flight'.

import type { Sql } from '../tenant-store.js'

// ── constants ──────────────────────────────────────────────────────────────────

/** Minutes after which an uncompleted 'claimed' row is considered stale. */
const STALE_CLAIM_MINUTES = 15

// ── types ──────────────────────────────────────────────────────────────────────

export type ClaimResult = 'fresh' | 'already-sent' | 'in-flight'

// ── claimRecipient ────────────────────────────────────────────────────────────

/**
 * Attempt to claim a delivery slot for (newsletterId, emailLower).
 *
 * Returns:
 *  - 'fresh'        → caller must send; row was newly inserted or stale-taken-over.
 *  - 'in-flight'    → a non-stale 'claimed' row exists; skip (another worker is sending).
 *  - 'already-sent' → a 'sent' row exists; do NOT re-send.
 *
 * The INSERT path and the stale-takeover UPDATE are both atomic at the DB level,
 * so two concurrent callers racing on the same (newsletterId, email) pair are
 * safe: at most one wins 'fresh', the other gets 'in-flight'.
 */
export async function claimRecipient(
  sql: Sql,
  newsletterId: number,
  emailLower: string,
): Promise<ClaimResult> {
  // Step 1: optimistic INSERT — fast path for a brand-new recipient.
  // ON CONFLICT DO NOTHING means if the row already exists we get 0 rows back.
  const inserted = await sql<{ id: number }[]>`
    INSERT INTO deliveries (newsletter_id, email)
    VALUES (${newsletterId}, ${emailLower})
    ON CONFLICT (newsletter_id, email) DO NOTHING
    RETURNING id
  `
  if (inserted.length > 0) {
    // Row was freshly inserted — we own it.
    return 'fresh'
  }

  // Step 2: row already exists. Check its status + staleness.
  // Try stale-takeover FIRST (atomic UPDATE with RETURNING).
  // This beats a plain SELECT + conditional UPDATE by avoiding a read-modify-write race.
  const cutoff = new Date(Date.now() - STALE_CLAIM_MINUTES * 60 * 1000).toISOString()
  const taken = await sql<{ id: number }[]>`
    UPDATE deliveries
    SET claimed_at = now()
    WHERE newsletter_id = ${newsletterId}
      AND email = ${emailLower}
      AND status = 'claimed'
      AND claimed_at < ${cutoff}::timestamptz
    RETURNING id
  `
  if (taken.length > 0) {
    // We won the stale-takeover race.
    return 'fresh'
  }

  // Step 3: inspect the current row to decide 'already-sent' vs 'in-flight'.
  const rows = await sql<{ status: string }[]>`
    SELECT status FROM deliveries
    WHERE newsletter_id = ${newsletterId}
      AND email = ${emailLower}
  `
  if (rows.length === 0) {
    // Shouldn't happen (we inserted or found it above), but handle defensively.
    return 'in-flight'
  }

  const status = rows[0]!.status
  if (status === 'sent') {
    return 'already-sent'
  }
  // status === 'claimed' (non-stale) — another worker is sending.
  return 'in-flight'
}

// ── markSent ──────────────────────────────────────────────────────────────────

/**
 * Mark a delivery as successfully sent.
 * Updates the deliveries row to status='sent', sets sent_at=now() and
 * smtp_message_id. Idempotent: a second call overwrites with the same data
 * (safe for at-least-once delivery confirmation).
 */
export async function markSent(
  sql: Sql,
  newsletterId: number,
  emailLower: string,
  messageId: string,
): Promise<void> {
  await sql`
    UPDATE deliveries
    SET status          = 'sent',
        sent_at         = now(),
        smtp_message_id = ${messageId}
    WHERE newsletter_id = ${newsletterId}
      AND email         = ${emailLower}
  `
}
