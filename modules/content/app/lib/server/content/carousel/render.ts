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
//
// In the running gremion-ui image this module is bundled into /app/build/server/chunks, so
// ./fonts does not exist next to it; gremion-ui/Dockerfile's runner stage copies the font
// directory to <cwd>/fonts/carousel (cwd = /app) and loadCarouselFont reads it from there.
// font-image.test.ts replays that COPY and fails if the two ever disagree.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

/** The committed font's file name. */
export const CAROUSEL_FONT_FILE = 'Inter-Regular.ttf'
/** Where the runtime image carries the font, relative to the process working directory (/app). */
export const CAROUSEL_RUNTIME_FONT_DIR = 'fonts/carousel'

/** Thrown when no candidate path holds the carousel font; names every place that was looked at. */
export class CarouselFontMissingError extends Error {
	constructor(readonly searched: readonly string[]) {
		super(
			`Carousel font ${CAROUSEL_FONT_FILE} not found. Looked in: ${searched.join(', ')}. ` +
				`The runtime image must carry it at <cwd>/${CAROUSEL_RUNTIME_FONT_DIR}/${CAROUSEL_FONT_FILE} ` +
				`(gremion-ui/Dockerfile, runner stage).`,
		)
		this.name = 'CarouselFontMissingError'
	}
}

/**
 * The places the font may live, best first: the runtime image path under the working directory,
 * then the committed ./fonts next to this module (a source checkout: tests, dev). The module
 * directory is derived LAZILY and defensively: a non-file import.meta.url under a test runner's
 * SSR transform must not crash the boot/registration graph, which imports this module without
 * ever rendering a slide. There is deliberately no `new URL('./fonts/...', import.meta.url)`
 * literal here, which the bundler would rewrite into an asset reference.
 */
export function carouselFontCandidates(cwd: string = process.cwd(), moduleDir?: string): string[] {
	let here = moduleDir
	if (here === undefined) {
		try {
			here = dirname(fileURLToPath(import.meta.url))
		} catch {
			here = undefined
		}
	}
	const candidates = [join(cwd, CAROUSEL_RUNTIME_FONT_DIR, CAROUSEL_FONT_FILE)]
	if (here !== undefined) candidates.push(join(here, 'fonts', CAROUSEL_FONT_FILE))
	return candidates
}

/** Read the first candidate that exists; throw CarouselFontMissingError (not ENOENT) when none does. */
export function loadCarouselFont(candidates: readonly string[] = carouselFontCandidates()): Buffer {
	for (const path of candidates) {
		if (existsSync(path)) return readFileSync(path)
	}
	throw new CarouselFontMissingError(candidates)
}

// Read + cache once, LAZILY (see carouselFontCandidates).
let fontData: Buffer | null = null
function interFont(): Buffer {
	if (fontData === null) fontData = loadCarouselFont()
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
