// gremion-ui/src/lib/server/news/portal-callback.ts
// Task 9 — kernel-local transaction logic for the portal-publish callback.
//
// Performs the idempotent news_posts write for the content engine's portal
// channel. The idempotency anchor is `news_posts.content_origin_post_id`
// (UUID of the content-service post, added by migration 047): if a row for
// that anchor already exists it is UPDATED; otherwise a new row is CREATED.
// Both paths finish by calling publishNewsPost so the row's published_at is
// always refreshed.
//
// Called from two entry points:
//   1. `portal-renderer.ts` (inprocess mode): passes a caller-supplied tx so
//      createNewsPost + updateNewsBodyHtml + publishNewsPost commit atomically
//      inside the renderer's own `getDb().begin()`. The `setPublication`
//      linkage is the renderer's responsibility (not here) so it rides the
//      same tx.
//   2. `+server.ts` (kernel callback endpoint): no tx supplied — this
//      function opens its own begin() and commits all three writes in one shot.
//
// Sanitization: bodyHtml is re-sanitized by `updateNewsBodyHtml` (which calls
// `sanitizeRichHtml` before storing). Defense-in-depth: callers may pre-sanitize
// but this function is authoritative.

import { getDb } from '../db'
import type { PgTransaction } from '../db/tx'
import type { NewsPost } from '@gremion/db'
import {
	createNewsPost,
	updateNewsBodyHtml,
	publishNewsPost,
} from './news-db'
import { getRunner } from '../db/tx'

export interface PortalCallbackInput {
	/** UUID of the content-service post — the idempotency anchor. */
	contentPostId: string
	title: string
	/** Raw or pre-sanitized HTML body; sanitized again at storage boundary. */
	bodyHtml: string
	/**
	 * KC user-id or synthetic id (e.g. 'system') to record as author_id on new
	 * rows. Has no effect on idempotent re-calls (the row is only updated, not
	 * re-inserted).
	 */
	authorId: string
	/**
	 * Optional: the existing news_posts id in string form (as the leaf records it
	 * via `external_ref`). When supplied and no row is found by `contentPostId`,
	 * this acts as a secondary key — the row is looked up by its numeric `id`
	 * instead of creating a new one. This supports rows that pre-date migration 047
	 * (i.e. have no `content_origin_post_id` yet).
	 */
	externalRef?: string
}

export interface PortalCallbackResult {
	/** Native news_posts row id (numeric). */
	newsId: number
	slug: string
	published_at: Date | null
	/** Echoes back the contentPostId that anchors this row. */
	content_origin_post_id: string
}

/**
 * Idempotent portal-publish kernel transaction.
 *
 * - If a `news_posts` row already has `content_origin_post_id = input.contentPostId`,
 *   it is updated (body + published_at) and returned.
 * - Otherwise a new row is created, anchored with `content_origin_post_id`, and
 *   returned.
 *
 * When `tx` is supplied the caller owns the transaction boundary (renderer
 * path). When omitted this function opens its own transaction (endpoint path).
 */
export async function portalCallback(
	input: PortalCallbackInput,
	tx?: PgTransaction,
): Promise<PortalCallbackResult> {
	if (tx) {
		return _run(input, tx)
	}
	return getDb().begin(async (newTx) => _run(input, newTx as PgTransaction))
}

async function _run(
	input: PortalCallbackInput,
	tx: PgTransaction,
): Promise<PortalCallbackResult> {
	const db = getRunner(tx, getDb)

	// Check if a news_posts row is already anchored to this content post.
	const existing = await db<Pick<NewsPost, 'id' | 'slug' | 'published_at'>[]>`
		SELECT id, slug, published_at
		FROM news_posts
		WHERE content_origin_post_id = ${input.contentPostId}
	`

	if (existing.length > 0) {
		const row = existing[0]
		// Re-publish: update the body and refresh published_at.
		await updateNewsBodyHtml(row.id, input.bodyHtml, tx)
		await publishNewsPost(row.id, tx)
		return {
			newsId: row.id,
			slug: row.slug,
			published_at: row.published_at,
			content_origin_post_id: input.contentPostId,
		}
	}

	// Secondary-key lookup: when the leaf supplied an externalRef (its own
	// recorded String(news_posts.id)), try to find the pre-047 row by numeric id
	// before falling through to creation. This prevents a duplicate row when the
	// row exists but has no content_origin_post_id yet.
	if (input.externalRef !== undefined) {
		const refId = parseInt(input.externalRef, 10)
		if (!isNaN(refId)) {
			const byRef = await db<Pick<NewsPost, 'id' | 'slug' | 'published_at'>[]>`
				SELECT id, slug, published_at
				FROM news_posts
				WHERE id = ${refId}
			`
			if (byRef.length > 0) {
				const row = byRef[0]
				await updateNewsBodyHtml(row.id, input.bodyHtml, tx)
				await publishNewsPost(row.id, tx)
				return {
					newsId: row.id,
					slug: row.slug,
					published_at: row.published_at,
					content_origin_post_id: input.contentPostId,
				}
			}
		}
	}

	// First publish: create the anchored row, fill the body, and publish — all
	// inside the caller's tx (or our own begin()) so there is no orphan window.
	const created = await createNewsPost(
		input.title,
		input.authorId,
		tx,
		input.contentPostId,
	)
	await updateNewsBodyHtml(created.id, input.bodyHtml, tx)
	await publishNewsPost(created.id, tx)
	return {
		newsId: created.id,
		slug: created.slug,
		published_at: created.published_at,
		content_origin_post_id: input.contentPostId,
	}
}
