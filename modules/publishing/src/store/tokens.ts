// services/newsletter/src/store/tokens.ts
//
// Send token + unsubscribe ops on a per-tenant postgres-js Sql pool.
// Ported from gremion-ui/src/lib/server/newsletter/newsletter-db.ts (G-009).
// All ops are async.

import type { Sql } from '../tenant-store.js'

// ── unsubscribes ───────────────────────────────────────────────────────────────

/**
 * Direct (non-token) unsubscribe — inserts email+token row (INSERT … ON CONFLICT DO NOTHING).
 * Mirrors addUnsubscribe() in the SQLite implementation.
 */
export async function addUnsubscribe(sql: Sql, email: string, token: string): Promise<void> {
  await sql`
    INSERT INTO unsubscribes (email, token)
    VALUES (${email}, ${token})
    ON CONFLICT (email) DO NOTHING
  `
}

/**
 * G-009 (route half): consume an unsubscribe token atomically.
 *
 * - Looks up the token.
 * - Missing → { ok: false, reason: 'invalid' } (no changes).
 * - Expired → deletes the token + returns { ok: false, reason: 'expired' }
 *   WITHOUT recording an unsubscribe (expired link must not silently succeed).
 * - Valid → inserts into unsubscribes + deletes the token (single-use),
 *   returns { ok: true }.
 *
 * All mutations are wrapped in a transaction so the token delete and the
 * unsubscribe insert are atomic.
 */
export async function addUnsubscribeByToken(
  sql: Sql,
  token: string,
): Promise<{ ok: true } | { ok: false; reason: 'invalid' | 'expired' }> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ newsletter_id: number; email: string; expires_at: Date | null }[]>`
      SELECT newsletter_id, email, expires_at
      FROM send_tokens
      WHERE token = ${token}
    `
    if (rows.length === 0) return { ok: false as const, reason: 'invalid' as const }

    const row = rows[0]!
    if (row.expires_at !== null && row.expires_at < new Date()) {
      // Expired: clean up the token so further hits return 'invalid'.
      await tx`DELETE FROM send_tokens WHERE token = ${token}`
      return { ok: false as const, reason: 'expired' as const }
    }

    // Valid: record unsubscribe and consume the token.
    await tx`
      INSERT INTO unsubscribes (email, token, unsubscribed_at)
      VALUES (${row.email}, ${token}, now())
      ON CONFLICT (email) DO NOTHING
    `
    await tx`DELETE FROM send_tokens WHERE token = ${token}`
    return { ok: true as const }
  })
}

export async function isUnsubscribed(sql: Sql, email: string): Promise<boolean> {
  const rows = await sql<{ c: string }[]>`
    SELECT COUNT(*) AS c FROM unsubscribes WHERE email = ${email}
  `
  return Number(rows[0]!.c) > 0
}

// ── send tokens ────────────────────────────────────────────────────────────────

/**
 * Mint (or reuse) the unsubscribe token for (newsletter_id, email) and return
 * the EFFECTIVE persisted token.
 *
 * send_tokens has UNIQUE(newsletter_id, email), so a re-send that passes a
 * new `token` hits the conflict and keeps the original — we read that back
 * and return it so the caller always uses the persisted token in the email.
 * (Mirrors addSendToken() in the SQLite implementation — SP-2 review MED-2.)
 *
 * The expires_at default (now() + 7 days) fires from the column DEFAULT in
 * migration 001.
 */
export async function addSendToken(
  sql: Sql,
  token: string,
  newsletterId: number,
  email: string,
): Promise<string> {
  await sql`
    INSERT INTO send_tokens (token, newsletter_id, email)
    VALUES (${token}, ${newsletterId}, ${email})
    ON CONFLICT (newsletter_id, email) DO NOTHING
  `
  const rows = await sql<{ token: string }[]>`
    SELECT token FROM send_tokens WHERE newsletter_id = ${newsletterId} AND email = ${email}
  `
  return rows[0]!.token
}

/**
 * Purge send tokens for newsletters sent more than 90 days ago.
 * Mirrors purgeSendTokensOlderThan90Days() in the SQLite implementation.
 */
export async function purgeSendTokensOlderThan90Days(sql: Sql): Promise<void> {
  await sql`
    DELETE FROM send_tokens
    WHERE newsletter_id IN (
      SELECT id FROM newsletters WHERE sent_at < now() - interval '90 days'
    )
  `
}
