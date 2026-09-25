// services/content/src/store/publications.ts
//
// Portal / email / Instagram publication linkage ops.
// Manages content.publications: which external resource a post's channel owns
// (e.g. portal: news_posts.id, instagram: Meta media id).

import type { Sql } from '../tenant-store.js'

// ── types ──────────────────────────────────────────────────────────────────────

export interface Publication {
  post_id: string
  channel: 'email' | 'portal' | 'instagram'
  external_ref: string | null
  published_at: string | null
}

// ── helpers ────────────────────────────────────────────────────────────────────

function toPublication(row: Record<string, unknown>): Publication {
  return {
    post_id: String(row['post_id']),
    channel: row['channel'] as Publication['channel'],
    external_ref: row['external_ref'] != null ? String(row['external_ref']) : null,
    published_at: row['published_at'] instanceof Date
      ? row['published_at'].toISOString()
      : row['published_at'] != null ? String(row['published_at']) : null,
  }
}

// ── ops ────────────────────────────────────────────────────────────────────────

/**
 * Create or update a publication row.
 * ON CONFLICT (post_id, channel) DO UPDATE allows re-publish to update external_ref.
 */
export async function createPublication(
  sql: Sql,
  data: { post_id: string; channel: 'email' | 'portal' | 'instagram'; external_ref?: string },
): Promise<void> {
  const ref = data.external_ref ?? null
  await sql`
    INSERT INTO content.publications (post_id, channel, external_ref, published_at)
    VALUES (${data.post_id}, ${data.channel}, ${ref}, now())
    ON CONFLICT (post_id, channel) DO UPDATE
      SET external_ref = EXCLUDED.external_ref,
          published_at = EXCLUDED.published_at
  `
}

export async function getPublication(
  sql: Sql,
  postId: string,
  channel: 'email' | 'portal' | 'instagram',
): Promise<Publication | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT post_id, channel, external_ref, published_at
    FROM content.publications
    WHERE post_id = ${postId} AND channel = ${channel}
  `
  return rows.length > 0 ? toPublication(rows[0]!) : null
}

export async function listPublications(sql: Sql, postId: string): Promise<Publication[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT post_id, channel, external_ref, published_at
    FROM content.publications
    WHERE post_id = ${postId}
    ORDER BY channel
  `
  return rows.map(toPublication)
}
