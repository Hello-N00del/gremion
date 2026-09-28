// Content Engine L3 — the Instagram publish outbox drain (disabled-by-default).
//
// `drainInstagramPublishOps()` is the per-tenant tick body that reconciles the
// `content.publish_ops` outbox (migration 046) against the Meta Graph carousel
// API. It mirrors the governance provisioning reconcile worker: pull every DUE
// op (listDuePublishOps — not-ok, retry-time arrived, not-given-up), reconcile
// each inside its own try/catch, and record the outcome (markPublishOpOk on
// success, markPublishOpFailed on any throw → capped backoff + give-up window in
// content-db). The UNIQUE(post_id, op) outbox key + status/backoff make a re-run
// idempotent and restart-safe, so a row still 'failed' next tick is simply
// retried — never double-published.
//
// FAIL-CLOSED / inert-when-disabled: when `isInstagramConfigured()` is false (the
// shipping default — no credentials), this returns IMMEDIATELY without touching a
// single op. That is deliberate: failing every due op would burn its give-up
// budget and churn the worker for a state (no credentials) that no retry can
// fix, so we leave the ops untouched (pending, immediately-due) for the moment
// activation flips credentials on. The route's ungranted capability + publish()'s
// own configured-gate already keep ops from being enqueued at all in normal
// operation; this is the third, drain-side guard.
//
// NotConfigured SEAM (Meta fetch-from-URL): Meta ingests each carousel slide from
// a PUBLIC HTTPS URL it fetches itself (design §11). The in-editor carousel route
// is auth-gated, NOT public, so producing public, expiring slide URLs is an
// ACTIVATION concern. In this disabled build there is no public slide host, so
// `resolvePublicSlideUrls()` returns null and the op is marked failed with a
// clear reason — we do NOT invent a host. Activation wires the public expiring
// URL producer here (and only then can the adapter step be reached).

import { getPost, listMedia, getChannels, markPublishOpOk, markPublishOpFailed, listDuePublishOps } from '../content-db'
import type { Post, PostChannel, PostMedia } from '../types'
import { instagramRenderer } from '../channels/instagram-renderer'
import { createInstagramAdapter, type SlideUpload } from './adapter'
import { isInstagramConfigured, resolveInstagramCredentials } from './credentials'

/**
 * Produce the public HTTPS slide URLs Meta will fetch, or null when no public
 * slide host is configured.
 *
 * This is the NotConfigured ACTIVATION SEAM. In the shipping (disabled) build
 * there is NO public slide host — the in-editor `/api/content/.../carousel/[index]`
 * route is auth-gated, not publicly fetchable by Meta — so this returns null and
 * the drain marks the op failed with a clear reason. We intentionally do NOT
 * invent a host here. Activation replaces this body with a real producer that
 * uploads the rendered PNGs to a public, short-lived (expiring) URL per slide
 * (e.g. signed object-store URLs), preserving slide order, and returns them.
 */
function resolvePublicSlideUrls(_pngs: Uint8Array[]): SlideUpload[] | null {
	// TODO(activation): wire a public, expiring per-slide URL producer (Meta
	// fetch-from-URL, design §11). No public slide host exists in the disabled
	// build, so there is nothing to hand Meta — fail closed.
	return null
}

/** The instagram channel row for a post (if any). */
async function instagramChannel(postId: string): Promise<PostChannel | null> {
	const channels = await getChannels(postId)
	return channels.find((c) => c.channel === 'instagram') ?? null
}

/**
 * The slide-URL producer the drain uses. Defaults to the disabled-build seam
 * (resolvePublicSlideUrls → null). Injectable ONLY so the unit suite can exercise
 * the adapter happy-path; production always uses the default (there is no public
 * host until activation wires one).
 */
export type SlideUrlProducer = (pngs: Uint8Array[]) => SlideUpload[] | null

/** Reconcile a single due op. Throws on any failure so the caller marks it failed. */
async function reconcileOne(
	opId: string,
	post: Post,
	media: PostMedia[],
	channel: PostChannel,
	produceSlideUrls: SlideUrlProducer,
): Promise<void> {
	// Render the carousel artifact (slides + PNG bytes + caption). render()
	// reuses the L1 pipeline, so the slide count/order match the editor preview.
	const artifact = await instagramRenderer.render(post, media, channel)
	if (artifact.kind !== 'instagram') {
		// instagramRenderer.render always returns the instagram artifact; this is a
		// type-narrowing guard only.
		throw new Error('instagram renderer returned a non-instagram artifact')
	}

	// NotConfigured seam: turn the rendered PNGs into public URLs Meta can fetch.
	const slideUrls = produceSlideUrls(artifact.pngs)
	if (slideUrls === null) {
		await markPublishOpFailed(opId, 'slide hosting not configured')
		return
	}

	// Credentials are present here (the caller gated on isInstagramConfigured),
	// but resolve them again for the adapter — fail-closed if they vanished.
	const creds = await resolveInstagramCredentials()
	if (creds === null) {
		await markPublishOpFailed(opId, 'Instagram not configured')
		return
	}

	const adapter = createInstagramAdapter()
	const { mediaId } = await adapter.publishCarousel(creds, slideUrls, artifact.caption)
	await markPublishOpOk(opId, mediaId)
}

/**
 * Drain the current tenant's due Instagram publish ops. INERT (returns at once,
 * no DB churn) when Instagram is not configured. Otherwise reconciles each due
 * op inside its own try/catch so one bad op never aborts the rest; an op whose
 * post/channel has vanished, or whose adapter step throws, is marked failed
 * (capped backoff + give-up). Resolves once every due op has been attempted.
 */
export async function drainInstagramPublishOps(
	produceSlideUrls: SlideUrlProducer = resolvePublicSlideUrls,
): Promise<void> {
	// Disabled-by-default fail-closed gate: no credentials → do nothing, leaving
	// ops untouched (no give-up burn) until activation flips credentials on.
	if (!(await isInstagramConfigured())) return

	const due = await listDuePublishOps()
	for (const op of due) {
		try {
			const post = await getPost(op.post_id)
			if (post === null) {
				await markPublishOpFailed(op.id, 'post no longer exists')
				continue
			}
			const channel = await instagramChannel(op.post_id)
			if (channel === null) {
				await markPublishOpFailed(op.id, 'instagram channel row missing')
				continue
			}
			const media = await listMedia(op.post_id)
			await reconcileOne(op.id, post, media, channel, produceSlideUrls)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			try {
				await markPublishOpFailed(op.id, message)
			} catch (markErr) {
				console.error(`[content-instagram-publish] failed to mark op ${op.id} failed:`, markErr)
			}
			console.error(`[content-instagram-publish] publish op ${op.id} (post ${op.post_id}) failed:`, err)
		}
	}
}
