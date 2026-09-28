// Content Engine (Pillar-1 kernel) — the server-side carousel PNG pipeline.
//
// Renders the placeholder `SlideTemplate` to a 1080x1080 PNG entirely in
// process and browser-free: satori turns the template node into an SVG string,
// then @resvg/resvg-js rasterizes that SVG to PNG bytes. `renderCarousel`
// derives the slide deck via the Instagram renderer and renders each slide,
// propagating the renderer's warnings (e.g. the >10-slide cap).
//
// The Inter .ttf font is committed under ./fonts (satori requires an explicit
// ttf/otf buffer; the repo's @fontsource packages ship only woff/woff2 which
// satori cannot use). It is read once and cached for the process lifetime.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import satori from 'satori'
import { instagramRenderer } from '../channels/instagram-renderer'
import type { Post, PostMedia, PostChannel } from '../types'
import { SlideTemplate, type SlideTemplateProps } from './template'

/** A rendered carousel: one 1080x1080 PNG per slide plus any cap/warnings. */
export interface CarouselResult {
	pngs: Uint8Array[]
	warnings: string[]
}

/** Square slide edge in pixels. */
const SLIDE_PX = 1080

// Resolve the committed Inter ttf relative to THIS module, LAZILY: the URL is
// built only when a carousel is actually rendered, so a non-file import.meta.url
// under a test runner's SSR transform cannot crash this module at import time
// (the boot/registration graph imports this module without ever rendering a
// slide). Read + cache once.
let fontData: Buffer | null = null
function interFont(): Buffer {
	if (fontData === null) {
		const fontPath = fileURLToPath(new URL('./fonts/Inter-Regular.ttf', import.meta.url))
		fontData = readFileSync(fontPath)
	}
	return fontData
}

/**
 * Rasterize one slide template to PNG bytes.
 * satori(node) -> SVG string -> new Resvg(svg).render().asPng() -> Uint8Array.
 */
export async function renderSlidePng(props: SlideTemplateProps): Promise<Uint8Array> {
	// satori's parameter is typed `ReactNode`; our template returns a plain
	// satori node (the documented `{ type, props }` shape satori walks).
	const svg = await satori(SlideTemplate(props) as unknown as Parameters<typeof satori>[0], {
		width: SLIDE_PX,
		height: SLIDE_PX,
		fonts: [{ name: 'Inter', data: interFont(), weight: 400, style: 'normal' }],
	})

	const png = new Resvg(svg, {
		fitTo: { mode: 'width', value: SLIDE_PX },
	})
		.render()
		.asPng()

	// asPng() returns a Node Buffer; expose it as a plain Uint8Array per contract.
	return new Uint8Array(png.buffer, png.byteOffset, png.byteLength)
}

/**
 * Derive the Instagram carousel for a post and render every slide to PNG,
 * propagating the renderer's warnings (incl. the >IG_MAX_SLIDES cap warning).
 */
export async function renderCarousel(
	post: Post,
	media: PostMedia[],
	channel: PostChannel,
	brand: { accent: string; logoUrl: string | null },
): Promise<CarouselResult> {
	const preview = instagramRenderer.derive(post, media, channel)
	const pngs: Uint8Array[] = []
	for (const slide of preview.slides) {
		pngs.push(await renderSlidePng({ brandTokens: brand, slide }))
	}
	return { pngs, warnings: preview.warnings }
}
