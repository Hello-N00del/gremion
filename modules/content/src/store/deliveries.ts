// services/content/src/store/deliveries.ts
//
// Per-recipient deliveries ledger — the duplicate-send gate.
// Mirrors services/newsletter/src/store/deliveries.ts adapted for UUID post_id
// and content.deliveries table, with an additional markFailed op.
//
// API:
//   claimRecipient(sql, postId, emailLower) → 'fresh' | 'already-sent' | 'in-flight'
//   markSent(sql, postId, emailLower, messageId) → void
//   markFailed(sql, postId, emailLower, errorMessage) → void
//   releaseClaim(sql, postId, emailLower) → void   (undo a fresh claim)
//
// Takeover: a stale 'claimed' row (STALE_CLAIM_MINUTES = 15, same as newsletter)
// and any 'failed' row are re-claimed atomically (F1-FIX-07 H07), so a recipient
// whose send threw is retried on the next publish and mailed at most once more.

import type { Sql } from '../tenant-store.js'

// ── constants ──────────────────────────────────────────────────────────────────

const STALE_CLAIM_MINUTES = 15

// ── types ──────────────────────────────────────────────────────────────────────

export type ClaimResult = 'fresh' | 'already-sent' | 'in-flight'

// ── claimRecipient ─────────────────────────────────────────────────────────────

/**
 * Attempt to claim a delivery slot for (postId, emailLower).
 *
 * Returns:
 *  - 'fresh'        → caller must send.
 *  - 'in-flight'    → another worker is sending; skip.
 *  - 'already-sent' → do NOT re-send.
 */
export async function claimRecipient(
  sql: Sql,
  postId: string,
  emailLower: string,
): Promise<ClaimResult> {
  // Step 1: optimistic INSERT — fast path for a brand-new recipient.
  const inserted = await sql<{ id: string }[]>`
    INSERT INTO content.deliveries (post_id, email)
    VALUES (${postId}, ${emailLower})
    ON CONFLICT (post_id, email) DO NOTHING
    RETURNING id
  `
  if (inserted.length > 0) {
    return 'fresh'
  }

  // Step 2: atomic takeover (one UPDATE, so exactly one concurrent caller wins):
  //  - a STALE 'claimed' row (its worker died mid-send; bounded at-least-once), or
  //  - a 'failed' row (F1-FIX-07 H07): the transport threw, so this recipient was
  //    not mailed on that pass. Without this branch a transient SMTP error drops
  //    the recipient for good. The row goes back to 'claimed' with the error
  //    cleared, so a concurrent second claimer sees 'in-flight', never 'fresh'.
  const cutoff = new Date(Date.now() - STALE_CLAIM_MINUTES * 60 * 1000).toISOString()
  const taken = await sql<{ id: string }[]>`
    UPDATE content.deliveries
    SET status        = 'claimed',
        claimed_at    = now(),
        failed_at     = NULL,
        error_message = NULL
    WHERE post_id = ${postId}
      AND email = ${emailLower}
      AND (
        status = 'failed'
        OR (status = 'claimed' AND claimed_at < ${cutoff}::timestamptz)
      )
    RETURNING id
  `
  if (taken.length > 0) {
    return 'fresh'
  }

  // Step 3: inspect current row.
  const rows = await sql<{ status: string }[]>`
    SELECT status FROM content.deliveries
    WHERE post_id = ${postId}
      AND email = ${emailLower}
  `
  if (rows.length === 0) {
    return 'in-flight'
  }

  const status = rows[0]!.status
  if (status === 'sent') {
    return 'already-sent'
  }
  return 'in-flight'
}

// ── markSent ──────────────────────────────────────────────────────────────────

export async function markSent(
  sql: Sql,
  postId: string,
  emailLower: string,
  messageId: string,
): Promise<void> {
  await sql`
    UPDATE content.deliveries
    SET status          = 'sent',
        sent_at         = now(),
        smtp_message_id = ${messageId}
    WHERE post_id = ${postId}
      AND email   = ${emailLower}
  `
}

// ── markFailed ────────────────────────────────────────────────────────────────

export async function markFailed(
  sql: Sql,
  postId: string,
  emailLower: string,
  errorMessage: string,
): Promise<void> {
  await sql`
    UPDATE content.deliveries
    SET status        = 'failed',
        failed_at     = now(),
        error_message = ${errorMessage}
    WHERE post_id = ${postId}
      AND email   = ${emailLower}
  `
}

// ── releaseClaim ────────────────────────────────────────────────────────────────

/**
 * Undo a just-made 'claimed' slot for (postId, emailLower) so a retry sees the
 * recipient as brand-new ('fresh') again. Used by the per-channel publish path
 * when SMTP is unconfigured: mirroring the in-kernel renderer's pre-check, we
 * must NOT leave a durable claim behind when nothing was actually sent (else a
 * later publish, once SMTP is configured, would skip that recipient). Only
 * removes rows still in 'claimed' state — never a 'sent'/'failed' row.
 */
export async function releaseClaim(
  sql: Sql,
  postId: string,
  emailLower: string,
): Promise<void> {
  await sql`
    DELETE FROM content.deliveries
    WHERE post_id = ${postId}
      AND email   = ${emailLower}
      AND status  = 'claimed'
  `
}
