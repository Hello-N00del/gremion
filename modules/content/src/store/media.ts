// services/content/src/store/media.ts
//
// Media CRUD ops on a per-tenant postgres-js Sql pool.
// Operates on content.post_media (UUID PKs, role/position/alt columns).

import type { Sql } from '../tenant-store.js'

// ── types ──────────────────────────────────────────────────────────────────────

export interface PostMedia {
  id: string
  post_id: string
  url: string
  role: 'hero' | 'slide' | 'inline'
  position: number
  alt: string | null
}

// ── helpers ────────────────────────────────────────────────────────────────────

function toMedia(row: Record<string, unknown>): PostMedia {
  return {
    id: String(row['id']),
    post_id: String(row['post_id']),
    url: row['url'] as string,
    role: row['role'] as PostMedia['role'],
    position: Number(row['position']),
    alt: row['alt'] != null ? String(row['alt']) : null,
  }
}

// ── ops ────────────────────────────────────────────────────────────────────────

export async function createMedia(
  sql: Sql,
  data: { post_id: string; url: string; role: 'hero' | 'slide' | 'inline'; position: number; alt?: string | null },
): Promise<PostMedia> {
  const alt = data.alt ?? null
  const rows = await sql<Record<string, unknown>[]>`
    INSERT INTO content.post_media (post_id, url, role, position, alt)
    VALUES (${data.post_id}, ${data.url}, ${data.role}, ${data.position}, ${alt})
    RETURNING *
  `
  return toMedia(rows[0]!)
}

export async function getMedia(sql: Sql, id: string): Promise<PostMedia | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM content.post_media WHERE id = ${id}
  `
  return rows.length > 0 ? toMedia(rows[0]!) : null
}

export async function listMediaByPost(sql: Sql, postId: string): Promise<PostMedia[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM content.post_media
    WHERE post_id = ${postId}
    ORDER BY position ASC, id ASC
  `
  return rows.map(toMedia)
}
