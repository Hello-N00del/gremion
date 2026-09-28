// Content Engine (Pillar-1 kernel) — the portal channel renderer.
//
// The portal renders the post on the public/portal site. The title is the post
// title and the body is re-sanitized through the shared rich-HTML sanitizer as
// defense-in-depth (the stored body_html is already sanitized on write, but the
// renderer never trusts its input).
//
// L1: `derive()` produces the in-editor portal preview (pure, deterministic).
// L2: `render()` produces the final portal artifact; `publish()` performs an
// IDEMPOTENT publish onto the existing news pipeline — it creates exactly one
// `news_posts` row the first time, records the linkage in `content.publications`
// (external_ref = the news_posts id as a string), and on every subsequent
// publish UPDATES that same row instead of creating a duplicate.
//
// L4 wiring (Task 9): the first-publish path delegates the news-DB writes to
// `portal-callback.ts` (portalCallback). The renderer no longer straddles both
// DBs directly; news_posts mutation is encapsulated in portal-callback, and the
// content.publications linkage is committed in the same tx so the two remain
// atomic. The re-publish path continues to update the already-linked row directly
// (no transaction needed — it is an idempotent update of a single, known row).

import { sanitizeRichHtml } from '../../security/html-sanitize'
import { getDb } from '../../db'
import {
	publishNewsPost,
	updateNewsBodyHtml,
} from '$lib/server/news/news-db'
import { portalCallback } from '$lib/server/news/portal-callback'
import { setPublication } from '../content-db'
import { getContentBackend } from '../backend'
import type { Post, PostMedia, PostChannel } from '../types'
import type { ChannelRenderer, PortalPreview, PublishResult, RenderedArtifact } from './types'

/** The portal renderer: L1 preview + L2 final artifact + idempotent publish. */
export const portalRenderer: ChannelRenderer<PortalPreview> = {
	channel: 'portal',

	derive(post: Post, _media: PostMedia[], _channel: PostChannel): PortalPreview {
		return {
			title: post.title,
			html: sanitizeRichHtml(post.body_html),
			warnings: [],
		}
	},

	/** The final portal artifact: title + re-sanitized body HTML. */
	render(post: Post, _media: PostMedia[], _channel: PostChannel): Promise<RenderedArtifact> {
		return Promise.resolve({
			kind: 'portal',
			title: post.title,
			html: sanitizeRichHtml(post.body_html),
		})
	},

	/**
	 * Idempotent portal publish. The `content.publications` row (PK
	 * post_id+channel) is the single source of truth for which `news_posts` row
	 * this post's portal channel owns:
	 *   - linkage with an external_ref → UPDATE that same news_posts row + re-publish;
	 *   - no linkage → delegate to portalCallback (creates/anchors the row, inside a
	 *     tx with setPublication so the news_posts row and its linkage commit
	 *     atomically). Never creates a duplicate; idempotency is anchored by
	 *     content_origin_post_id (migration 047).
	 * `updateNewsBodyHtml` re-sanitizes the body at the storage boundary.
	 */
	async publish(post: Post, _media: PostMedia[], _channel: PostChannel): Promise<PublishResult> {
		const backend = getContentBackend()
		const html = sanitizeRichHtml(post.body_html)

		const existing = await backend.getPublication(post.id, 'portal')
		let externalRef: string

		if (existing?.external_ref) {
			// Re-publish: target the SAME news_posts row (idempotent update).
			externalRef = existing.external_ref
			const newsId = Number(externalRef)
			await updateNewsBodyHtml(newsId, html)
			await publishNewsPost(newsId)
		} else {
			// First publish: delegate news-DB writes to portalCallback, committed
			// atomically with the content.publications linkage in one tx so there is
			// no orphan window (and thus no duplicate on retry).
			externalRef = await getDb().begin(async (tx) => {
				const result = await portalCallback(
					{
						contentPostId: post.id,
						title: post.title,
						bodyHtml: html,
						authorId: post.created_by,
					},
					tx,
				)
				const ref = String(result.newsId)
				await setPublication(post.id, 'portal', ref, tx)
				return ref
			})
		}

		await backend.setChannelStatus(post.id, 'portal', 'published')

		return {
			channel: 'portal',
			status: 'published',
			externalRef,
			warnings: [],
		}
	},
}
