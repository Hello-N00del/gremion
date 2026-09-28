// Content Engine (Pillar-1 kernel) — the ChannelRenderer port and the
// per-channel preview models.
//
// A `ChannelRenderer` is the single seam every fan-out channel (email, portal,
// Instagram) plugs into. In L1 a renderer only `derive()`s a *preview* model
// from a post + its media + its per-channel state; `render()` (final artifact)
// and `publish()` (push to the external channel) are added in L2/L3 and are
// deliberately NOT part of this port yet.
//
// The preview models are the LOCKED L1 contracts shared by the renderers, the
// carousel pipeline, the API preview routes, and the editor UI — keep the
// names/types verbatim.

import type { ChannelId, ChannelStatus, Post, PostMedia, PostChannel } from '../types'

/**
 * One slide of an Instagram carousel.
 * - `cover`  — title card (heading = post title, hero image if present).
 * - `content`— one per body section (heading + plain-text excerpt).
 * - `cta`    — optional trailing call-to-action / handle card.
 * `index` is 0-based; `total` is the slide count after capping/overrides.
 */
export interface SlideModel {
	kind: 'cover' | 'content' | 'cta'
	heading: string
	body: string
	imageUrl: string | null
	index: number
	total: number
}

/** Email preview: a subject line + the post body HTML (rendered in an iframe). */
export interface EmailPreview {
	subject: string
	html: string
	warnings: string[]
}

/** Portal preview: a page title + sanitized body HTML for in-portal rendering. */
export interface PortalPreview {
	title: string
	html: string
	warnings: string[]
}

/** Instagram preview: the capped slide deck + composed caption. */
export interface InstagramPreview {
	/** Capped at IG_MAX_SLIDES; overflow surfaced via `warnings`. */
	slides: SlideModel[]
	caption: string
	warnings: string[]
}

/** The union of every channel's L1 preview model. */
export type ChannelPreview = EmailPreview | PortalPreview | InstagramPreview

// ── L2 final artifacts + publish result (LOCKED) ─────────────────────────────
//
// `render()` produces the FINAL artifact a channel sends (subject+html for
// email, title+html for portal, the slide deck + caption for Instagram).
// `publish()` actually pushes that artifact to the external channel and returns
// a `PublishResult` describing the outcome. Both are added to the port in L2;
// email/portal get real bodies (Tasks 3/4), Instagram's publish stays an L3 stub.

/** The final email artifact: a subject line + sanitized body HTML. */
export interface EmailArtifact {
	kind: 'email'
	subject: string
	html: string
}

/** The final portal artifact: a page title + sanitized body HTML. */
export interface PortalArtifact {
	kind: 'portal'
	title: string
	html: string
}

/**
 * The final Instagram artifact: the slide deck + composed caption (L3 publish).
 * `pngs` carries the rendered 1080x1080 slide bytes (one per `slides` entry, in
 * order) so the IG drain can produce per-slide upload URLs without re-running
 * the satori/resvg pipeline.
 */
export interface InstagramArtifact {
	kind: 'instagram'
	slides: SlideModel[]
	caption: string
	pngs: Uint8Array[]
}

/** The union of every channel's final (renderable) artifact. */
export type RenderedArtifact = EmailArtifact | PortalArtifact | InstagramArtifact

/**
 * The outcome of a `publish()` call.
 * - `status`         — 'sent' (email) | 'published' (portal) | 'failed'.
 * - `recipientCount` — email: how many recipients were sent to this pass.
 * - `externalRef`    — portal: the owned `news_posts` id as a string.
 * - `warnings`       — non-fatal notes surfaced to the operator.
 * - `detail`         — a human-readable explanation (esp. on 'failed').
 */
export interface PublishResult {
	channel: ChannelId
	status: ChannelStatus
	recipientCount?: number
	externalRef?: string
	warnings: string[]
	detail?: string
}

/**
 * The channel seam. Every fan-out channel plugs in here.
 *
 * - `derive()`  — L1: a deterministic in-editor *preview* model.
 * - `render()`  — L2: the FINAL artifact a channel sends.
 * - `publish()` — L2/L3: push the artifact to the external channel.
 */
export interface ChannelRenderer<P extends ChannelPreview = ChannelPreview> {
	readonly channel: ChannelId
	derive(post: Post, media: PostMedia[], channel: PostChannel): P
	render(post: Post, media: PostMedia[], channel: PostChannel): Promise<RenderedArtifact>
	publish(post: Post, media: PostMedia[], channel: PostChannel): Promise<PublishResult>
}
