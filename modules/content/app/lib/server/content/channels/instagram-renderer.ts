// Content Engine (Pillar-1 kernel) — the Instagram channel renderer
// (L1 derive + L3 render/publish).
//
// Instagram fan-out is a carousel of square slides plus one plain-text caption.
// The slide deck is built deterministically from the post:
//   [ cover, ...one content slide per body section, (optional) cta ]
// then any per-channel `overrides` are overlaid, the deck is capped at
// IG_MAX_SLIDES (overflow surfaced as a warning, never silently dropped), and
// finally `index`/`total` are stamped on each slide so the renderer/UI need no
// further bookkeeping. The caption is composed by rule (composeCaption).
//
// Pure and deterministic: calling derive twice with the same inputs yields
// deep-equal output (no clock, randomness, network, or filesystem).

// jsdom is imported untyped (no `@types/jsdom` dependency is added on purpose,
// matching segment.ts/caption.ts); its window is re-typed to the DOM lib below.
// Typed by the local ambient declaration in jsdom-shim.d.ts (the toolchain guard allows
// the expect-error suppression directive only in *.test.ts).
import { JSDOM } from 'jsdom'
import { composeCaption, IG_MAX_SLIDES } from '../caption'
import { renderCarousel } from '../carousel/render'
import { enqueuePublishOp } from '../content-db'
import { isInstagramConfigured } from '../instagram/credentials'
import { segmentBody } from '../segment'
import type { Post, PostMedia, PostChannel } from '../types'
import type {
	ChannelRenderer,
	InstagramArtifact,
	InstagramPreview,
	PublishResult,
	RenderedArtifact,
	SlideModel,
} from './types'

/**
 * Default carousel brand tokens used by `render()`. The renderer takes no brand
 * argument (the ChannelRenderer port is fixed), so the artifact is rendered with
 * neutral defaults; resolving the real per-tenant accent/logo for the actual
 * outbound publish is the drain's job (L3-T4).
 */
const DEFAULT_BRAND = { accent: '#1d4ed8', logoUrl: null } as const

interface JsdomWindow {
	document: Document
}
interface JsdomInstance {
	window: JsdomWindow
}

/** Fixed handle/link line shown on the trailing CTA slide. */
const CTA_BODY = 'Mehr auf dem Portal — Link in Bio.'

/** Plain-text excerpt of a section's html (tags stripped, whitespace collapsed). */
function htmlToPlainText(html: string): string {
	if (!html || html.trim() === '') return ''
	const { window } = new JSDOM('<!DOCTYPE html><body></body>') as JsdomInstance
	window.document.body.innerHTML = html
	const text = window.document.body.textContent ?? ''
	return text.replace(/\s+/g, ' ').trim()
}

/** True when `v` is a plain object (a candidate JSONB override map). */
function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Overlay a single per-slide override map onto a derived slide. Only the
 * editable text/image fields are overlaid; `kind`, `index`, and `total` are
 * structural and never come from overrides. Strings overlay heading/body;
 * `imageUrl` accepts a string or explicit null.
 */
function overlaySlide(base: SlideModel, ov: Record<string, unknown>): SlideModel {
	const next: SlideModel = { ...base }
	if (typeof ov.heading === 'string') next.heading = ov.heading
	if (typeof ov.body === 'string') next.body = ov.body
	if (typeof ov.imageUrl === 'string') next.imageUrl = ov.imageUrl
	else if (ov.imageUrl === null) next.imageUrl = null
	return next
}

/** The L1 Instagram renderer. `derive()` produces the in-editor carousel preview. */
export const instagramRenderer: ChannelRenderer<InstagramPreview> = {
	channel: 'instagram',

	derive(post: Post, media: PostMedia[], channel: PostChannel): InstagramPreview {
		const warnings: string[] = []
		const sections = segmentBody(post.body_html)

		// Hero image (lowest-position 'hero', deterministic) backs the cover slide.
		const heroes = media
			.filter((m) => m.role === 'hero')
			.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
		const heroUrl = heroes.length > 0 ? heroes[0].url : null

		// 1) Build the deck WITHOUT index/total (stamped after capping).
		const deck: Array<Omit<SlideModel, 'index' | 'total'>> = []
		deck.push({ kind: 'cover', heading: post.title, body: '', imageUrl: heroUrl })
		for (const section of sections) {
			deck.push({
				kind: 'content',
				heading: section.heading,
				body: htmlToPlainText(section.html),
				imageUrl: null,
			})
		}
		deck.push({ kind: 'cta', heading: '', body: CTA_BODY, imageUrl: null })

		// 2) Cap at IG_MAX_SLIDES (truncate the tail; surface a warning).
		let capped = deck
		if (deck.length > IG_MAX_SLIDES) {
			warnings.push(
				`carousel truncated to ${IG_MAX_SLIDES} slides (was ${deck.length})`,
			)
			capped = deck.slice(0, IG_MAX_SLIDES)
		}

		// 3) Stamp index/total, producing the final SlideModels.
		const total = capped.length
		let slides: SlideModel[] = capped.map((s, index) => ({ ...s, index, total }))

		// 4) Overlay per-slide overrides last (overrides.slides[i] over slide i).
		const ovSlides = channel.overrides?.slides
		if (Array.isArray(ovSlides)) {
			slides = slides.map((slide, i) => {
				const ov = ovSlides[i]
				return isRecord(ov) ? overlaySlide(slide, ov) : slide
			})
		}

		// 5) Caption: composed by rule, then an optional override replaces it.
		const composed = composeCaption(post, sections)
		warnings.push(...composed.warnings)
		const ovCaption = channel.overrides?.caption
		const caption = typeof ovCaption === 'string' ? ovCaption : composed.caption

		return { slides, caption, warnings }
	},

	/**
	 * The final Instagram artifact: the capped slide deck + composed caption +
	 * the rendered 1080x1080 PNG bytes (one per slide). Reuses the L1
	 * `renderCarousel` pipeline (which itself `derive()`s the deck and rasterizes
	 * each slide) and this renderer's `derive()` for the caption, so the slide
	 * count, cap, and ordering match the preview exactly.
	 */
	async render(post: Post, media: PostMedia[], channel: PostChannel): Promise<RenderedArtifact> {
		const preview = this.derive(post, media, channel)
		const { pngs } = await renderCarousel(post, media, channel, DEFAULT_BRAND)
		const artifact: InstagramArtifact = {
			kind: 'instagram',
			slides: preview.slides,
			caption: preview.caption,
			pngs,
		}
		return artifact
	},

	/**
	 * Disabled-by-default Instagram publish (the transactional-outbox enqueue).
	 *
	 * When credentials are absent (`isInstagramConfigured()` is false — the
	 * shipping default) this returns a `failed` result WITHOUT enqueuing an op:
	 * an op the drain could never fulfil would only burn its give-up budget. The
	 * route's ungranted `content.publish.instagram` capability is the first gate;
	 * this is the second (credentials), so the path stays inert two ways.
	 *
	 * When configured, it enqueues a single idempotent `content.publish_ops` row
	 * (UNIQUE(post_id, op)) and returns `scheduled`; the per-tenant IG drain
	 * (L3-T4) reconciles it to the Meta Graph carousel API.
	 */
	async publish(post: Post, media: PostMedia[], channel: PostChannel): Promise<PublishResult> {
		const { warnings } = this.derive(post, media, channel)
		if (!(await isInstagramConfigured())) {
			return {
				channel: 'instagram',
				status: 'failed',
				detail: 'Instagram not configured',
				warnings: [],
			}
		}
		await enqueuePublishOp(post.id)
		return {
			channel: 'instagram',
			status: 'scheduled',
			detail: 'queued for Instagram publish',
			warnings,
		}
	},
}
