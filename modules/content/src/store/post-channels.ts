// services/content/src/store/post-channels.ts
//
// Per-channel recipient set helpers for content posts.
// Manages content.post_recipients: which mailing lists / KC groups a post's
// email channel fans out to.

import type { Sql } from '../tenant-store.js'

// ── types ──────────────────────────────────────────────────────────────────────

export interface PostRecipient {
  id: string
  post_id: string
  mailing_list_id: string | null
  keycloak_group_id: string | null
}

// ── helpers ────────────────────────────────────────────────────────────────────

function toRecipient(row: Record<string, unknown>): PostRecipient {
  return {
    id: String(row['id']),
    post_id: String(row['post_id']),
    mailing_list_id: row['mailing_list_id'] != null ? String(row['mailing_list_id']) : null,
    keycloak_group_id: row['keycloak_group_id'] != null ? String(row['keycloak_group_id']) : null,
  }
}

// ── ops ────────────────────────────────────────────────────────────────────────

/**
 * Replace all recipients for a (postId, channel) pair.
 * Deletes all existing post_recipients rows for the post and re-inserts.
 * Note: post_recipients does not have a channel column per the DDL, so
 * recipients are shared across channels. The channel parameter is kept
 * for API symmetry with the brief interface.
 */
export async function setPostChannelRecipients(
  sql: Sql,
  postId: string,
  _channel: 'email' | 'portal' | 'instagram',
  recipients: Array<{ mailing_list_id?: string; keycloak_group_id?: string }>,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM content.post_recipients WHERE post_id = ${postId}`
    for (const r of recipients) {
      const listId = r.mailing_list_id ?? null
      const groupId = r.keycloak_group_id ?? null
      await tx`
        INSERT INTO content.post_recipients (post_id, mailing_list_id, keycloak_group_id)
        VALUES (${postId}, ${listId}, ${groupId})
      `
    }
  })
}

/**
 * Get all recipients for a post (channel parameter kept for API symmetry).
 */
export async function getPostChannelRecipients(
  sql: Sql,
  postId: string,
  _channel: 'email' | 'portal' | 'instagram',
): Promise<PostRecipient[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, post_id, mailing_list_id, keycloak_group_id
    FROM content.post_recipients
    WHERE post_id = ${postId}
  `
  return rows.map(toRecipient)
}
