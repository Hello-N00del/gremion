// services/content/src/store/publish-ops.ts
//
// Instagram publish outbox ops (publish_ops table from § 046).
// Provides the durable IG-publish intent queue: enqueue, inspect, update,
// and drain due ops. Shipped disabled-by-default (activation is separately
// ticketed — see 001_init.sql § 046 notes).

import type { Sql } from '../tenant-store.js'

// ── types ──────────────────────────────────────────────────────────────────────

export interface PublishOp {
  id: string
  post_id: string
  channel: 'instagram'
  op: 'publish'
  status: 'pending' | 'ok' | 'failed'
  attempts: number
  next_attempt_at: string | null
  first_failed_at: string | null
  last_error: string | null
  external_ref: string | null
  created_at: string
  updated_at: string
}

// ── helpers ────────────────────────────────────────────────────────────────────

function toNullableDate(v: unknown): string | null {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  return String(v as string | number)
}

function toPublishOp(row: Record<string, unknown>): PublishOp {
  return {
    id: String(row['id']),
    post_id: String(row['post_id']),
    channel: 'instagram',
    op: 'publish',
    status: row['status'] as PublishOp['status'],
    attempts: Number(row['attempts']),
    next_attempt_at: toNullableDate(row['next_attempt_at']),
    first_failed_at: toNullableDate(row['first_failed_at']),
    last_error: row['last_error'] != null ? (row['last_error'] as string) : null,
    external_ref: row['external_ref'] != null ? (row['external_ref'] as string) : null,
    created_at: row['created_at'] instanceof Date
      ? row['created_at'].toISOString()
      : String(row['created_at']),
    updated_at: row['updated_at'] instanceof Date
      ? row['updated_at'].toISOString()
      : String(row['updated_at']),
  }
}

// ── constants ──────────────────────────────────────────────────────────────────

/**
 * How long (in seconds) to retry a failing publish op before giving up.
 * Mirrors kernel's PUBLISH_OP_GIVE_UP_AFTER_SECONDS in content-db.ts.
 */
export const PUBLISH_OP_GIVE_UP_SECONDS = 24 * 60 * 60

// ── ops ────────────────────────────────────────────────────────────────────────

/**
 * Create (or return existing) a publish op for the given post.
 * UNIQUE(post_id, op) ensures idempotency — a second call returns the same row.
 */
export async function createPublishOp(
  sql: Sql,
  data: { post_id: string },
): Promise<PublishOp> {
  // Insert if not exists; then return the authoritative row.
  await sql`
    INSERT INTO content.publish_ops (post_id)
    VALUES (${data.post_id})
    ON CONFLICT (post_id, op) DO NOTHING
  `
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM content.publish_ops
    WHERE post_id = ${data.post_id} AND op = 'publish'
  `
  return toPublishOp(rows[0]!)
}

export async function getPublishOp(sql: Sql, id: string): Promise<PublishOp | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM content.publish_ops WHERE id = ${id}
  `
  return rows.length > 0 ? toPublishOp(rows[0]!) : null
}

/**
 * Update a publish op after an attempt.
 */
export async function updatePublishOp(
  sql: Sql,
  id: string,
  data: Partial<Pick<PublishOp, 'status' | 'attempts' | 'next_attempt_at' | 'first_failed_at' | 'last_error' | 'external_ref'>>,
): Promise<void> {
  const fields = Object.keys(data) as Array<keyof typeof data>
  if (fields.length === 0) return

  const ALLOWED: ReadonlySet<string> = new Set([
    'status', 'attempts', 'next_attempt_at', 'first_failed_at', 'last_error', 'external_ref',
  ])
  for (const f of fields) {
    if (!ALLOWED.has(f)) throw new Error(`[publish-ops-store] disallowed update field: ${f}`)
  }

  const setClauses = fields.map((f, i) => `"${f}" = $${i + 1}`).join(', ')
  const values: unknown[] = fields.map((f) => data[f] ?? null)
  values.push(id)

  await sql.unsafe(
    `UPDATE content.publish_ops SET ${setClauses}, updated_at = now() WHERE id = $${values.length}`,
    values as Parameters<typeof sql.unsafe>[1],
  )
}

/**
 * Drain due publish ops: pending rows where next_attempt_at IS NULL or <= now(),
 * and within the give-up window (first_failed_at within the last 24 h).
 * Excludes 'ok' rows and ops that have been failing for > PUBLISH_OP_GIVE_UP_SECONDS.
 * Returns up to 50 rows for processing.
 */
export async function drainPublishOps(sql: Sql): Promise<PublishOp[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM content.publish_ops
    WHERE status <> 'ok'
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      AND (first_failed_at IS NULL OR now() - first_failed_at < interval '24 hours')
    ORDER BY created_at ASC
    LIMIT 50
  `
  return rows.map(toPublishOp)
}
