// DB-backed suite for the L3 Instagram publish-outbox helpers (content.publish_ops,
// migration 046). Runs under `test:integration` against a real Postgres
// (vitest.integration.config.ts; tests/integration/setup.ts establishes the
// default tenant in ALS). The `content` schema (044) + its L2 (045) + L3 outbox
// (046) migrations are applied here in beforeAll, all idempotent (IF NOT EXISTS),
// so the suite is self-contained whether or not the content module is enabled.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../db'
import {
	createPost,
	enqueuePublishOp,
	listDuePublishOps,
	getPublishOp,
	markPublishOpOk,
	markPublishOpFailed,
} from './content-db'

describe('content-db L3 publish-ops outbox (integration)', () => {
	beforeAll(async () => {
		// The migration files wrap their DDL in BEGIN;…COMMIT;. Running that via
		// sql.unsafe() on the POOLED connection throws
		//   UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1.
		// Reserve one dedicated connection so the embedded transaction is permitted.
		const reserved = await getDb().reserve()
		try {
			for (const file of [
				'044_content_schema.sql',
				'045_content_publish.sql',
				'046_content_publish_ops.sql',
			]) {
				const ddl = readFileSync(join(process.cwd(), 'migrations', file), 'utf-8')
				await reserved.unsafe(ddl)
			}
		} finally {
			reserved.release()
		}
	})

	beforeEach(async () => {
		// posts cascades to publish_ops (FK ON DELETE CASCADE)
		await getDb()`TRUNCATE content.posts RESTART IDENTITY CASCADE`
	})

	it('enqueuePublishOp inserts a pending, immediately-due op and is idempotent', async () => {
		const post = await createPost({ title: 'IG', created_by: 'u1' })
		await enqueuePublishOp(post.id)
		await enqueuePublishOp(post.id) // ON CONFLICT(post_id,op) DO NOTHING — no second row

		const op = await getPublishOp(post.id)
		expect(op).not.toBeNull()
		expect(op!.status).toBe('pending')
		expect(op!.channel).toBe('instagram')
		expect(op!.op).toBe('publish')
		expect(op!.attempts).toBe(0)
		expect(op!.next_attempt_at).toBeNull() // immediately due
		expect(op!.first_failed_at).toBeNull()
		expect(op!.external_ref).toBeNull()

		// exactly one row despite two enqueues
		const rows = await getDb()<{ c: string }[]>`SELECT COUNT(*) AS c FROM content.publish_ops WHERE post_id = ${post.id}`
		expect(Number(rows[0]!.c)).toBe(1)

		// a pending op with next_attempt_at NULL is due
		const due = await listDuePublishOps()
		expect(due.map((o) => o.post_id)).toContain(post.id)
	})

	it('getPublishOp returns null for a post with no op', async () => {
		const post = await createPost({ title: 'NoOp', created_by: 'u1' })
		expect(await getPublishOp(post.id)).toBeNull()
	})

	it('markPublishOpOk → status ok, external_ref set, no longer due', async () => {
		const post = await createPost({ title: 'OkPath', created_by: 'u1' })
		await enqueuePublishOp(post.id)
		const op = await getPublishOp(post.id)
		await markPublishOpOk(op!.id, 'meta-media-123')

		const after = await getPublishOp(post.id)
		expect(after!.status).toBe('ok')
		expect(after!.external_ref).toBe('meta-media-123')
		expect(after!.last_error).toBeNull()
		expect(after!.next_attempt_at).toBeNull()
		expect(after!.first_failed_at).toBeNull()

		// ok ops are excluded from the due list (status <> 'ok')
		const due = await listDuePublishOps()
		expect(due.map((o) => o.post_id)).not.toContain(post.id)
	})

	it('markPublishOpFailed increments attempts, stamps first_failed_at, and backs off (not immediately due)', async () => {
		const post = await createPost({ title: 'FailPath', created_by: 'u1' })
		await enqueuePublishOp(post.id)
		const op = await getPublishOp(post.id)

		await markPublishOpFailed(op!.id, 'meta 400 bad container')
		const a1 = await getPublishOp(post.id)
		expect(a1!.status).toBe('failed')
		expect(a1!.attempts).toBe(1)
		expect(a1!.last_error).toBe('meta 400 bad container')
		expect(a1!.first_failed_at).not.toBeNull()
		expect(a1!.next_attempt_at).not.toBeNull() // backoff scheduled into the future

		// next_attempt_at is in the future → excluded from the due list right now
		const dueNow = await listDuePublishOps()
		expect(dueNow.map((o) => o.post_id)).not.toContain(post.id)

		// a second failure increments attempts again and keeps the original first_failed_at
		const firstFailedAt = a1!.first_failed_at
		await markPublishOpFailed(op!.id, 'meta 500')
		const a2 = await getPublishOp(post.id)
		expect(a2!.attempts).toBe(2)
		expect(a2!.first_failed_at).toBe(firstFailedAt) // COALESCE keeps the original
	})

	it('a failed op becomes due again once next_attempt_at has passed', async () => {
		const sql = getDb()
		const post = await createPost({ title: 'Retry', created_by: 'u1' })
		await enqueuePublishOp(post.id)
		const op = await getPublishOp(post.id)
		await markPublishOpFailed(op!.id, 'transient')
		// backdate the retry time into the past
		await sql`UPDATE content.publish_ops SET next_attempt_at = now() - interval '1 minute' WHERE id = ${op!.id}`
		const due = await listDuePublishOps()
		expect(due.map((o) => o.post_id)).toContain(post.id)
	})

	it('listDuePublishOps excludes an op that has been failing past the give-up window', async () => {
		const sql = getDb()
		const post = await createPost({ title: 'GiveUp', created_by: 'u1' })
		await enqueuePublishOp(post.id)
		const op = await getPublishOp(post.id)
		await markPublishOpFailed(op!.id, 'persistent')
		// first_failed_at older than 24h AND retry time already past → terminal, not due
		await sql`UPDATE content.publish_ops
			SET first_failed_at = now() - interval '25 hours', next_attempt_at = now() - interval '1 minute'
			WHERE id = ${op!.id}`
		const due = await listDuePublishOps()
		expect(due.map((o) => o.post_id)).not.toContain(post.id)
	})

	it('a successful re-mark after failure clears failure state and external_ref persists', async () => {
		const post = await createPost({ title: 'Recover', created_by: 'u1' })
		await enqueuePublishOp(post.id)
		const op = await getPublishOp(post.id)
		await markPublishOpFailed(op!.id, 'transient')
		await markPublishOpOk(op!.id, 'meta-final')
		const after = await getPublishOp(post.id)
		expect(after!.status).toBe('ok')
		expect(after!.external_ref).toBe('meta-final')
		expect(after!.last_error).toBeNull()
		expect(after!.first_failed_at).toBeNull()
		expect(after!.next_attempt_at).toBeNull()
	})
})
