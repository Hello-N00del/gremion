// gremion-ui/src/lib/server/news-db.ts
// News post CRUD for the B5 public portal Aktuelles section.
// Slug generation helpers are exported for unit tests.

import { getDb } from '../db.js';
import { getRunner } from '../db/tx';
import type { PgTransaction } from '../db/tx';
import type { NewsPost } from '@gremion/db';
import { sanitizeRichHtml } from '../security/html-sanitize';

// --- Slug helpers (exported for unit tests) ---

export function generateSlug(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')       // strip non-alphanumeric (except spaces)
    .trim()
    .replace(/\s+/g, '-')              // spaces → hyphens
    .replace(/-+/g, '-')               // collapse runs
    .replace(/^-|-$/g, '');            // trim leading/trailing hyphens
}

export function deduplicateSlug(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

async function freshSlug(title: string, tx?: PgTransaction): Promise<string> {
  const db = getRunner(tx, getDb);
  const base = generateSlug(title);
  const rows = await db<{ slug: string }[]>`
    SELECT slug FROM news_posts WHERE slug LIKE ${base + '%'}
  `;
  return deduplicateSlug(base, rows.map((r) => r.slug));
}

// --- CRUD ---

export async function listNewsPosts(): Promise<NewsPost[]> {
  const db = getDb();
  return db<NewsPost[]>`
    SELECT * FROM news_posts ORDER BY created_at DESC
  `;
}

export async function getNewsPostById(id: number): Promise<NewsPost | null> {
  const db = getDb();
  const rows = await db<NewsPost[]>`
    SELECT * FROM news_posts WHERE id = ${id}
  `;
  return rows[0] ?? null;
}

export async function createNewsPost(
  title: string,
  authorId: string,
  tx?: PgTransaction,
  contentOriginPostId?: string
): Promise<NewsPost> {
  const db = getRunner(tx, getDb);
  const slug = await freshSlug(title, tx);
  const rows = contentOriginPostId
    ? await db<NewsPost[]>`
        INSERT INTO news_posts (title, slug, body_html, author_id, content_origin_post_id)
        VALUES (${title}, ${slug}, '', ${authorId}, ${contentOriginPostId})
        RETURNING *
      `
    : await db<NewsPost[]>`
        INSERT INTO news_posts (title, slug, body_html, author_id)
        VALUES (${title}, ${slug}, '', ${authorId})
        RETURNING *
      `;
  return rows[0];
}

/**
 * Update the body_html of a news post. The value is sanitized with
 * `sanitizeRichHtml` before storage as defence-in-depth — callers in
 * `routes/api/news/[id]/+server.ts` and `routes/news/[id]/edit/+page.server.ts`
 * also sanitize at the trust boundary; this second pass is idempotent
 * and ensures any future caller that forgets cannot store raw HTML.
 */
export async function updateNewsBodyHtml(
  id: number,
  bodyHtml: string,
  tx?: PgTransaction
): Promise<void> {
  const safe = sanitizeRichHtml(bodyHtml);
  const db = getRunner(tx, getDb);
  await db`
    UPDATE news_posts
    SET body_html = ${safe}, updated_at = now()
    WHERE id = ${id}
  `;
}

export async function publishNewsPost(id: number, tx?: PgTransaction): Promise<void> {
  const db = getRunner(tx, getDb);
  await db`
    UPDATE news_posts
    SET published_at = now(), updated_at = now()
    WHERE id = ${id}
  `;
}

export async function unpublishNewsPost(id: number): Promise<void> {
  const db = getDb();
  await db`
    UPDATE news_posts
    SET published_at = NULL, updated_at = now()
    WHERE id = ${id}
  `;
}

export async function deleteNewsPost(id: number): Promise<void> {
  const db = getDb();
  await db`DELETE FROM news_posts WHERE id = ${id}`;
}
