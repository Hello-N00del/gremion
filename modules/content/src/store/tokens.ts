// services/content/src/store/tokens.ts
//
// Send token + unsubscribe ops on a per-tenant postgres-js Sql pool.
// Mirrors services/newsletter/src/store/tokens.ts adapted for:
//   - content.unsubscribes (email PRIMARY KEY, no token column)
//   - content.send_tokens (post_id UUID FK, not newsletter_id)
//
// Note: content.unsubscribes only has (email, created_at) per the DDL,
// so addUnsubscribe takes email only. The token column does not exist on
// content.unsubscribes (differs from newsletter pattern).

import type { Sql } from '../tenant-store.js'

// ── unsubscribes ───────────────────────────────────────────────────────────────

/**
 * Record an unsubscribe for the given email address.
 * Idempotent: duplicate emails are silently ignored (email is PRIMARY KEY).
 */
export async function addUnsubscribe(sql: Sql, email: string): Promise<void> {
  await sql`
    INSERT INTO content.unsubscribes (email)
    VALUES (${email})
    ON CONFLICT (email) DO NOTHING
  `
}

export async function isUnsubscribed(sql: Sql, email: string): Promise<boolean> {
  const rows = await sql<{ c: string }[]>`
    SELECT COUNT(*) AS c FROM content.unsubscribes WHERE email = ${email}
  `
  return Number(rows[0]!.c) > 0
}

// ── send tokens ────────────────────────────────────────────────────────────────

/**
 * Mint (or reuse) the unsubscribe token for (post_id, email).
 * send_tokens has UNIQUE(post_id, email) so a re-send conflict returns the
 * original persisted token.
 */
export async function addSendToken(
  sql: Sql,
  token: string,
  postId: string,
  email: string,
): Promise<string> {
  await sql`
    INSERT INTO content.send_tokens (token, post_id, email)
    VALUES (${token}, ${postId}, ${email})
    ON CONFLICT (post_id, email) DO NOTHING
  `
  const rows = await sql<{ token: string }[]>`
    SELECT token FROM content.send_tokens WHERE post_id = ${postId} AND email = ${email}
  `
  return rows[0]!.token
}

/**
 * Purge send tokens for posts sent more than 90 days ago.
 */
export async function purgeSendTokensOlderThan90Days(sql: Sql): Promise<void> {
  await sql`
    DELETE FROM content.send_tokens
    WHERE post_id IN (
      SELECT id FROM content.posts WHERE sent_at < now() - interval '90 days'
    )
  `
}
