// services/content/src/store/posts.ts
//
// Post CRUD + recipients + claim/reset ops on a per-tenant postgres-js Sql pool.
// Mirrors services/newsletter/src/store/newsletters.ts adapted for the content
// schema (UUID PKs, content.posts, content.post_recipients).

import type { Sql } from '../tenant-store.js'

// ── types ──────────────────────────────────────────────────────────────────────

export interface ContentPost {
  id: string       // UUID
  slug: string
  title: string
  body_html: string
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed'
  scheduled_at: string | null
  sent_at: string | null
  error: string | null
  created_by: string
  created_at: string
  updated_at: string
}

// ── helpers ────────────────────────────────────────────────────────────────────

function toDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (v == null) return String(v)
  return String(v)
}

function toNullableDate(v: unknown): string | null {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

function toPost(row: Record<string, unknown>): ContentPost {
  return {
    id: String(row['id']),
    slug: row['slug'] as string,
    title: row['title'] as string,
    body_html: row['body_html'] as string,
    status: (row['status'] as ContentPost['status']) ?? 'draft',
    scheduled_at: toNullableDate(row['scheduled_at']),
    sent_at: toNullableDate(row['sent_at']),
    error: row['error'] != null ? String(row['error']) : null,
    created_by: row['created_by'] as string,
    created_at: toDate(row['created_at']),
    updated_at: toDate(row['updated_at']),
  }
}

// ── post CRUD ─────────────────────────────────────────────────────────────────

export async function createPost(
  sql: Sql,
  data: { slug: string; title: string; body_html: string; created_by: string },
): Promise<ContentPost> {
  // posts table has no status column in 001_init.sql DDL — we track publish
  // lifecycle via post_channels. For dispatching we maintain a lightweight
  // status on the post row via a virtual column pattern: we add it as DEFAULT
  // column via COALESCE since the posts table only has created_at/updated_at.
  // Actually, looking at the DDL: the posts table doesn't have a status column.
  // The brief requires status on the ContentPost type returned here, so we
  // derive it via a LEFT JOIN on post_channels, or we add a status column.
  // The DDL in 001_init.sql does NOT include a status column on content.posts —
  // status lives on content.post_channels (per-channel).
  //
  // For the store interface the brief says:
  //   claimPostForPublish, resetStuckPublishing, updatePost(status/scheduled_at/sent_at/error)
  // These ops require a status column on posts. We add it via a virtual/computed
  // approach: store status, scheduled_at, sent_at, error as extra columns that
  // we maintain. Since the DDL is hash-locked, we must work with what exists.
  //
  // Looking at the DDL more carefully: content.posts only has
  //   id, slug, title, body_html, created_by, created_at, updated_at
  // It does NOT have status/scheduled_at/sent_at/error.
  //
  // The brief says posts.ts mirrors newsletters.ts which has these columns.
  // The DDL in 001_init.sql needs to have them for this to work.
  // Since the brief says to mirror newsletters.ts against the 001_init.sql DDL,
  // and 001_init.sql does NOT have those columns on posts, we need to check
  // if they should be derived from post_channels or if the posts table needs
  // them added.
  //
  // Decision (brief says "author against 001_init.sql DDL"): the posts table
  // in 001_init.sql lacks status/scheduled_at/sent_at/error, but the brief
  // interface requires these ops. The post_channels table has status per channel.
  // For a "global" post status (the claim/reset lifecycle), we derive from
  // a computed approach or use post_channels.email.status as the primary channel.
  //
  // However, the simplest approach that honors the brief contract WITHOUT
  // modifying the hash-locked 001_init.sql is: add those columns at runtime
  // via SQL only if they don't exist. But that is messy.
  //
  // Re-reading 001_init.sql: post_channels has per-channel status. The brief
  // says claimPostForPublish transitions to 'sending'. The cleanest approach:
  // store a post-level status as the 'email' post_channel status, since that
  // is the primary channel. But the brief also says updatePost takes
  // { status, scheduled_at, sent_at, error } — mirroring newsletter fields.
  //
  // FINAL DECISION: We use content.posts.updated_at for the stuck check and
  // add the status/scheduling fields as NULLABLE columns on the posts table
  // via a secondary migration. But since 001_init.sql is hash-locked and
  // we can't add a migration in this task (manifest.json is auto-regenerated
  // by build:manifest), we use the existing post_channels table with a
  // composite approach: store a synthetic "dispatch" channel row with channel='email'.
  //
  // Actually, the cleanest solution: post_channels already has status + scheduled_at.
  // We create an 'email' post_channel entry automatically when a post is created,
  // and claimPostForPublish updates that row. updatePost maps to post_channels.
  // purgeSendTokensOlderThan90Days joins posts to send_tokens via post_id.
  //
  // BUT: countPostRecipients, claimPostForPublish etc. operate per-post, not
  // per-channel. The brief's getPost must return a post with a status field.
  //
  // Let me re-read the 001_init.sql once more... posts table truly has no
  // status column. However the brief's ContentPost type includes status, and
  // updatePost takes { status, scheduled_at, sent_at, error }.
  //
  // The posts table in the DDL is indeed missing these. The most pragmatic
  // approach that avoids touching the hash-locked migration: we use the
  // 'email' post_channel row as the status carrier (since email is the primary
  // dispatch channel). But then post_channels has different valid statuses:
  //   'draft' | 'scheduled' | 'sent' | 'published' | 'failed'
  // vs our ContentPost needs 'sending' status.
  //
  // Alternative: ignore the DDL gap and store status directly in posts by
  // executing ALTER TABLE at migration time via an additional migration file.
  // But we can't add migrations here — the hash is locked.
  //
  // FINAL FINAL: I'll add the status columns directly to the posts table
  // using a separate migration (002_posts_status.sql). The manifest must be
  // regenerated via `pnpm --filter content-service build:manifest` as noted
  // in the cross-task notes ("Later tasks that add new migrations MUST
  // regenerate manifest.json via `pnpm --filter content-service build:manifest`
  // or the deploy-drift test will fail."). Task 16 is adding the store —
  // the store needs these columns, so a migration is appropriate.
  //
  // Write posts as-is; the migration will be added below in a separate file.
  const rows = await sql<Record<string, unknown>[]>`
    INSERT INTO content.posts (slug, title, body_html, created_by)
    VALUES (${data.slug}, ${data.title}, ${data.body_html}, ${data.created_by})
    RETURNING *
  `
  return toPost(rows[0]!)
}

export async function listPosts(sql: Sql): Promise<ContentPost[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM content.posts ORDER BY created_at DESC
  `
  return rows.map(toPost)
}

export async function getPost(sql: Sql, id: string): Promise<ContentPost | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM content.posts WHERE id = ${id}
  `
  return rows.length > 0 ? toPost(rows[0]!) : null
}

/**
 * Partial-update a post. Only the provided fields are SET.
 */
export async function updatePost(
  sql: Sql,
  id: string,
  data: Partial<Pick<ContentPost, 'status' | 'scheduled_at' | 'sent_at' | 'error' | 'title' | 'body_html'>>,
): Promise<void> {
  const fields = Object.keys(data) as Array<keyof typeof data>
  if (fields.length === 0) return

  const ALLOWED: ReadonlySet<string> = new Set([
    'status', 'scheduled_at', 'sent_at', 'error', 'title', 'body_html',
  ])
  for (const f of fields) {
    if (!ALLOWED.has(f)) throw new Error(`[post-store] disallowed update field: ${f}`)
  }

  const setClauses = fields.map((f, i) => `"${f}" = $${i + 1}`).join(', ')
  const values: unknown[] = fields.map((f) => data[f] ?? null)
  values.push(id)

  await sql.unsafe(
    `UPDATE content.posts SET ${setClauses} WHERE id = $${values.length}`,
    values as Parameters<typeof sql.unsafe>[1],
  )
}

// ── claim / reset ─────────────────────────────────────────────────────────────

/**
 * Atomically claim a post for publishing.
 * Returns true iff the row was transitioned to 'sending'.
 */
export async function claimPostForPublish(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE content.posts
    SET status = 'sending'
    WHERE id = ${id}
      AND status NOT IN ('sending', 'sent')
    RETURNING id
  `
  return rows.length > 0
}

/**
 * Reset posts that have been in 'sending' status longer than stuckMinutes.
 * Sets status to 'failed'. Returns the number of rows reset.
 */
export async function resetStuckPublishing(sql: Sql, stuckMinutes: number): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    UPDATE content.posts
    SET status = 'failed'
    WHERE status = 'sending'
      AND updated_at < now() - (${stuckMinutes} || ' minutes')::interval
    RETURNING id
  `
  return rows.length
}

// ── due scheduled channels (A1 keying) ──────────────────────────────────────────

/** A channel armed for timed publish, keyed by (post_id, channel). */
export interface DueChannel {
  post_id: string
  channel: 'email' | 'portal' | 'instagram'
}

/**
 * List DUE scheduled channels — the content.post_channels rows the per-channel
 * arm path (PATCH /posts/:id/channels/:channel) writes for timed publish:
 * enabled=true, status='scheduled', scheduled_at<=now().
 *
 * A1: this is the scheduler's dispatch key. The whole-post content.posts.status
 * is NOT consulted (the arm path never sets it), so a channel armed via the API
 * is picked up here. Oldest-scheduled first, bounded by `limit`.
 */
export async function listDueScheduledChannels(sql: Sql, limit = 50): Promise<DueChannel[]> {
  const rows = await sql<{ post_id: string; channel: string }[]>`
    SELECT post_id, channel
    FROM content.post_channels
    WHERE enabled = true
      AND status = 'scheduled'
      AND scheduled_at IS NOT NULL
      AND scheduled_at <= now()
    ORDER BY scheduled_at ASC
    LIMIT ${limit}
  `
  return rows.map((r) => ({
    post_id: String(r.post_id),
    channel: r.channel as DueChannel['channel'],
  }))
}

// ── counts ────────────────────────────────────────────────────────────────────

/**
 * Resolved recipient count for one post via its email-channel mailing lists.
 */
export async function countPostRecipients(sql: Sql, postId: string): Promise<number> {
  const rows = await sql<{ c: string }[]>`
    SELECT COUNT(DISTINCT m.email) AS c
    FROM content.post_recipients r
    JOIN content.mailing_list_members m ON m.mailing_list_id = r.mailing_list_id
    WHERE r.post_id = ${postId}
      AND r.mailing_list_id IS NOT NULL
  `
  return Number(rows[0]!.c)
}
