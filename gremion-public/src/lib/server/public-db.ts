// gremion-public/src/lib/server/public-db.ts
// Read-only DB queries for the public portal.
// Uses a dedicated low-privilege Postgres connection (GREMION_PUBLIC_DB_URL).

import postgres from 'postgres';
import { env } from '$env/dynamic/private';
import type { PublicProtocol, PublicCommittee } from '@gremion/db/public-types';
import { isUuid } from '$lib/validate';

let _db: ReturnType<typeof postgres> | null = null;

export function getPublicDb(): ReturnType<typeof postgres> {
  if (!_db) {
    const url = env.GREMION_PUBLIC_DB_URL;
    if (!url) throw new Error('GREMION_PUBLIC_DB_URL not configured');
    _db = postgres(url, { max: 5 });
  }
  return _db;
}

// ---------------------------------------------------------------------------
// Protocols
// ---------------------------------------------------------------------------

/** Returns published protocols, optionally filtered by committee UUID, newest first. */
export async function getPublishedProtocols(
  committeeId?: string,
  limit = 50
): Promise<PublicProtocol[]> {
  const sql = getPublicDb();

  // #262 D5: defence-in-depth — a non-UUID committeeId degrades to "no filter"
  // so it can never reach the `${committeeId}::uuid` cast and 500. Callers should
  // already validate, but this keeps the cast safe for any future caller.
  const filterId = isUuid(committeeId) ? committeeId : null;

  const rows = await sql<PublicProtocol[]>`
    SELECT
      p.id,
      p.committee_id,
      p.meeting_date,
      p.title,
      p.body_html,
      p.pdf_nextcloud_path,
      p.created_at,
      c.name AS committee_name,
      CASE WHEN p.pdf_nextcloud_path IS NOT NULL
           THEN '/api/public/protocols/' || p.id::text || '/pdf'
           ELSE NULL
      END AS pdf_url
    FROM   protocols p
    JOIN   org_units c ON c.id = p.committee_id
    WHERE  p.status = 'published'
      AND  c.visibility = 'all_members'
      AND  (${filterId}::uuid IS NULL OR p.committee_id = ${filterId}::uuid)
    ORDER  BY p.meeting_date DESC
    LIMIT  ${limit}
  `;
  return rows;
}

/** Returns a single published protocol by UUID with resolved PDF URL. */
export async function getPublishedProtocolById(id: string): Promise<PublicProtocol | null> {
  // #262 D5: a non-UUID id never matches a real row — short-circuit to null so it
  // can never reach the `${id}::uuid` cast and 500 the public route.
  if (!isUuid(id)) return null;
  const sql = getPublicDb();
  const rows = await sql<PublicProtocol[]>`
    SELECT
      p.id,
      p.committee_id,
      p.meeting_date,
      p.title,
      p.body_html,
      p.pdf_nextcloud_path,
      p.created_at,
      c.name AS committee_name,
      CASE WHEN p.pdf_nextcloud_path IS NOT NULL
           THEN '/api/public/protocols/' || p.id::text || '/pdf'
           ELSE NULL
      END AS pdf_url
    FROM   protocols p
    JOIN   org_units c ON c.id = p.committee_id
    WHERE  p.id     = ${id}::uuid
      AND  p.status = 'published'
      AND  c.visibility = 'all_members'
    LIMIT  1
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Committees (for filter dropdowns)
// ---------------------------------------------------------------------------

export async function getAllCommittees(): Promise<PublicCommittee[]> {
  const sql = getPublicDb();
  // Only publicly-visible org units may cross the anonymous boundary. Without
  // the visibility filter, committee_only units leaked their name/description
  // and parent topology to the internet via the homepage tree and the
  // /protokolle filter dropdown (#250). The visibility column itself is not
  // projected (it is not part of PublicCommittee).
  const rows = await sql<PublicCommittee[]>`
    SELECT id, name, description, parent_id, created_at
    FROM   org_units
    WHERE  visibility = 'all_members'
    ORDER  BY name ASC
  `;
  return rows;
}
