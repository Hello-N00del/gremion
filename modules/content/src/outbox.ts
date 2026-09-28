// services/content/src/outbox.ts
//
// Transactional outbox for the content leaf.
//
// Design mirrors services/newsletter/src/outbox.ts:
//  - enqueueOutbox() is called INSIDE the same transaction that changes post state,
//    so the outbox row is co-committed (never a phantom publish, never a missed
//    publish on crash).
//  - drainOutbox() fetches due rows (status='pending' OR status='failed'
//    with next_attempt_at <= now()), processes them via the supplied publish
//    callback, and marks ok / failed with backoff.
//  - Backoff expression mirrors gremion-ui/provisioning/ledger.ts (P0.3a):
//      LEAST(3600, 30 * 2^min(attempts+1, 12)) seconds
//  - Terminal: first_failed_at older than GIVE_UP_AFTER_SECONDS = 24h. The row
//    is left in status='failed' (no further retries) but IS NOT deleted so the
//    operator can inspect it.

import type { Sql } from './tenant-store.js'
import type { ContentEvent } from '@gremion/ports/broker'

/** 24 hours — matches ledger.ts GIVE_UP_AFTER_SECONDS. */
export const GIVE_UP_AFTER_SECONDS = 24 * 60 * 60

/** Shape of a row returned from the outbox query. */
export interface OutboxRow {
  id: string
  event_type: string
  payload: unknown
  correlation_id: string | null
  status: 'pending' | 'ok' | 'failed'
  attempts: number
  next_attempt_at: Date | null
  first_failed_at: Date | null
  last_error: string | null
  created_at: Date
}

/**
 * Enqueue an outbox row inside an existing postgres-js transaction.
 * Must be called within the same tx that transitions post state so the
 * outbox row is co-committed (atomic publish guarantee).
 *
 * @param tx           postgres-js transaction Sql (the value yielded by sql.begin())
 * @param eventType    Short ContentEvent ('publish.succeeded' | 'channel.email.sent' | …)
 * @param payload      Arbitrary JSON payload stored in the outbox.
 * @param correlationId Optional correlation id.
 */
export async function enqueueOutbox(
  tx: Sql,
  eventType: ContentEvent,
  payload: unknown,
  correlationId: string | null = null,
): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO outbox (event_type, payload, correlation_id)
    VALUES (${eventType}, ${tx.json(payload as Parameters<typeof tx.json>[0])}, ${correlationId})
    RETURNING id
  `
  return rows[0]!.id
}

/**
 * Fetch due outbox rows for a single drain pass.
 *
 * A row is "due" when:
 *  - status = 'pending' (fresh, never attempted), OR
 *  - status = 'failed' AND next_attempt_at <= now() AND
 *      first_failed_at > now() - GIVE_UP_AFTER_SECONDS (not yet terminal).
 *
 * Rows are locked (SELECT … FOR UPDATE SKIP LOCKED) so concurrent relay workers
 * do not double-publish.
 */
export async function fetchDueRows(sql: Sql, limit = 50): Promise<OutboxRow[]> {
  return sql<OutboxRow[]>`
    SELECT id, event_type, payload, correlation_id, status, attempts,
           next_attempt_at, first_failed_at, last_error, created_at
    FROM outbox
    WHERE status = 'pending'
       OR (
         status = 'failed'
         AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         AND (
           first_failed_at IS NULL
           OR now() - first_failed_at < make_interval(secs => ${GIVE_UP_AFTER_SECONDS})
         )
       )
    ORDER BY created_at
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `
}

/**
 * Mark an outbox row as successfully published.
 * Clears all backoff / error fields (reset-on-recovery semantics).
 */
export async function markOutboxOk(sql: Sql, id: string): Promise<void> {
  await sql`
    UPDATE outbox SET
      status          = 'ok',
      last_error      = NULL,
      next_attempt_at = NULL,
      first_failed_at = NULL,
      attempts        = 0
    WHERE id = ${id}
  `
}

/**
 * Mark an outbox row as failed, increment attempts, and schedule the next retry
 * using the capped exponential backoff expression from ledger.ts (P0.3a).
 */
export async function markOutboxFailed(sql: Sql, id: string, error: string): Promise<void> {
  await sql`
    UPDATE outbox SET
      status          = 'failed',
      last_error      = ${error.slice(0, 2000)},
      attempts        = attempts + 1,
      next_attempt_at = now() + make_interval(
        secs => LEAST(3600, 30 * power(2, LEAST(attempts + 1, 12))::int)),
      first_failed_at = COALESCE(first_failed_at, now())
    WHERE id = ${id}
  `
}

/**
 * High-level drain: iterates due rows, calls publishFn for each, and marks
 * ok or failed. All DB mutations happen in the SAME read-lock transaction so
 * the FOR UPDATE SKIP LOCKED range is held for the duration of the batch.
 *
 * Returns counts of ok / failed rows in this pass.
 */
export async function drainOutbox(
  sql: Sql,
  publishFn: (row: OutboxRow) => Promise<void>,
  limit = 50,
): Promise<{ ok: number; failed: number }> {
  let okCount = 0
  let failedCount = 0

  await sql.begin(async (tx) => {
    const rows = await fetchDueRows(tx as unknown as Sql, limit)
    for (const row of rows) {
      try {
        await publishFn(row)
        await markOutboxOk(tx as unknown as Sql, row.id)
        okCount++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await markOutboxFailed(tx as unknown as Sql, row.id, msg)
        failedCount++
      }
    }
  })

  return { ok: okCount, failed: failedCount }
}
