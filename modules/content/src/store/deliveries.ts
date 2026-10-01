// services/content/src/store/deliveries.ts
//
// Per-recipient deliveries ledger — the duplicate-send gate.
// Mirrors services/newsletter/src/store/deliveries.ts adapted for UUID post_id
// and content.deliveries table, with an additional markFailed op.
//
// API:
//   claimRecipient(sql, postId, emailLower) → 'fresh' | 'already-sent' | 'in-flight'
//   claimDelivery(sql, postId, emailLower) → { result, claimedAt }  (claim token)
//   markSent(sql, postId, emailLower, messageId) → void   (never rewrites a 'sent' row)
//   markFailed(sql, postId, emailLower, errorMessage, claimedAt?) → void
//                                                    (only a 'claimed' row; with the
//                                                     token, only the caller's claim)
//   releaseClaim(sql, postId, emailLower) → void   (undo a fresh claim)
//
// Takeover: a stale 'claimed' row (STALE_CLAIM_MINUTES = 15, same as newsletter)
// and any 'failed' row are re-claimed atomically (F1-FIX-07 H07), so a recipient
// whose send threw is retried on the next publish. Because 'failed' is now
// re-claimable, markFailed never overwrites 'sent' (r2): a worker that hung past
// the stale window and fails late cannot turn a delivered row into a re-send.
// The HTTP claim route returns the token (claim_token) and the /failed route
// fences on it (R29-LOW-07 L1). Residual: a /failed request WITHOUT a token (a
// caller that predates the token) keeps the status-only fence, so its late
// failure can still flip a live takeover claim to 'failed' until that claimer's
// markSent. markSent is deliberately never fenced.

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
  return (await claimDelivery(sql, postId, emailLower)).result
}

/** A claim plus, when 'fresh', the token identifying THIS claim. */
export interface DeliveryClaim {
  result: ClaimResult
  /**
   * The claim's claimed_at as epoch microseconds in text (exact and time-zone
   * free; a JS Date or a timestamptz parameter would drop the microseconds), set
   * only when result is 'fresh'. Pass it to markFailed so a superseded claimer
   * (its claim was taken over after the stale window) cannot fail the live claim.
   */
  claimedAt: string | null
}

/**
 * claimRecipient, also returning the claim token (F1-FIX-07 r2). The leaf's own
 * send loops (publish-channel, dispatch) and the HTTP claim route use this.
 */
export async function claimDelivery(
  sql: Sql,
  postId: string,
  emailLower: string,
): Promise<DeliveryClaim> {
  // Step 1: optimistic INSERT — fast path for a brand-new recipient.
  const inserted = await sql<{ claimed_at: string }[]>`
    INSERT INTO content.deliveries (post_id, email)
    VALUES (${postId}, ${emailLower})
    ON CONFLICT (post_id, email) DO NOTHING
    RETURNING (EXTRACT(EPOCH FROM claimed_at) * 1000000)::bigint::text AS claimed_at
  `
  if (inserted.length > 0) {
    return { result: 'fresh', claimedAt: inserted[0]!.claimed_at }
  }

  // Step 2: atomic takeover (one UPDATE, so exactly one concurrent caller wins):
  //  - a STALE 'claimed' row (its worker died mid-send; bounded at-least-once), or
  //  - a 'failed' row (F1-FIX-07 H07): the transport threw, so this recipient was
  //    not mailed on that pass. Without this branch a transient SMTP error drops
  //    the recipient for good. The row goes back to 'claimed' with the error
  //    cleared, so a concurrent second claimer sees 'in-flight', never 'fresh'.
  const cutoff = new Date(Date.now() - STALE_CLAIM_MINUTES * 60 * 1000).toISOString()
  // clock_timestamp(), not now(): now() is the transaction start, so a takeover
  // inside a caller's transaction could repeat the old token.
  const taken = await sql<{ claimed_at: string }[]>`
    UPDATE content.deliveries
    SET status        = 'claimed',
        claimed_at    = clock_timestamp(),
        failed_at     = NULL,
        error_message = NULL
    WHERE post_id = ${postId}
      AND email = ${emailLower}
      AND (
        status = 'failed'
        OR (status = 'claimed' AND claimed_at < ${cutoff}::timestamptz)
      )
    RETURNING (EXTRACT(EPOCH FROM claimed_at) * 1000000)::bigint::text AS claimed_at
  `
  if (taken.length > 0) {
    return { result: 'fresh', claimedAt: taken[0]!.claimed_at }
  }

  // Step 3: inspect current row.
  const rows = await sql<{ status: string }[]>`
    SELECT status FROM content.deliveries
    WHERE post_id = ${postId}
      AND email = ${emailLower}
  `
  if (rows.length === 0) {
    return { result: 'in-flight', claimedAt: null }
  }

  const status = rows[0]!.status
  if (status === 'sent') {
    return { result: 'already-sent', claimedAt: null }
  }
  return { result: 'in-flight', claimedAt: null }
}

// ── markSent ──────────────────────────────────────────────────────────────────

/**
 * Record a delivery. Any non-'sent' row may become 'sent' — the mail went out,
 * so this is true even when a superseded claimer's late markFailed (kernel HTTP
 * path, no token) already flipped the claim to 'failed'; letting that 'failed'
 * stand would re-send on the next publish. A row already 'sent' keeps its first
 * sent_at and message id.
 */
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
      AND status <> 'sent'
  `
}

// ── markFailed ────────────────────────────────────────────────────────────────

/**
 * Record a failed send (F1-FIX-07 r2). Only a 'claimed' row can fail: since
 * 'failed' rows are re-claimed, overwriting a 'sent' row would mail the
 * recipient again. With `claimedAt` (the token from claimDelivery) only the
 * claimer's own claim is touched, never one a later worker took over.
 */
export async function markFailed(
  sql: Sql,
  postId: string,
  emailLower: string,
  errorMessage: string,
  claimedAt?: string,
): Promise<void> {
  if (claimedAt !== undefined) {
    await sql`
      UPDATE content.deliveries
      SET status        = 'failed',
          failed_at     = now(),
          error_message = ${errorMessage}
      WHERE post_id    = ${postId}
        AND email      = ${emailLower}
        AND status     = 'claimed'
        AND (EXTRACT(EPOCH FROM claimed_at) * 1000000)::bigint::text = ${claimedAt}
    `
    return
  }
  await sql`
    UPDATE content.deliveries
    SET status        = 'failed',
        failed_at     = now(),
        error_message = ${errorMessage}
    WHERE post_id = ${postId}
      AND email   = ${emailLower}
      AND status  = 'claimed'
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
  claimedAt?: string,
): Promise<void> {
  if (claimedAt !== undefined) {
    // With the claim token: only the caller's own claim, never a takeover's.
    await sql`
      DELETE FROM content.deliveries
      WHERE post_id    = ${postId}
        AND email      = ${emailLower}
        AND status     = 'claimed'
        AND (EXTRACT(EPOCH FROM claimed_at) * 1000000)::bigint::text = ${claimedAt}
    `
    return
  }
  await sql`
    DELETE FROM content.deliveries
    WHERE post_id = ${postId}
      AND email   = ${emailLower}
      AND status  = 'claimed'
  `
}
