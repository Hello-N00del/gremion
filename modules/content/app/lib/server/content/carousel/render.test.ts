// @vitest-environment node
// Unit tests for the satori -> resvg carousel PNG pipeline. Runs in `node`:
// satori + resvg are native/SSR APIs and the test asserts real PNG bytes.
import { describe, it, expect } from 'vitest'
import { renderSlidePng, renderCarousel } from './render'
import { IG_MAX_SLIDES } from '../caption'
import type { Post, PostChannel, PostMedia } from '../types'
import type { SlideModel } from '../channels/types'

/** The 8-byte PNG signature. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const brand = { accent: '#123456', logoUrl: null }

function coverSlide(): SlideModel {
	return { kind: 'cover', heading: 'Hi', body: '', imageUrl: null, index: 0, total: 1 }
}

function post(bodyHtml: string): Post {
	return {
		id: 'p1',
		slug: 'hello',
		title: 'Hello World',
		body_html: bodyHtml,
		created_by: 'u1',
		created_at: '2026-06-29T00:00:00.000Z',
		updated_at: '2026-06-29T00:00:00.000Z',
	}
}

const channel: PostChannel = {
	post_id: 'p1',
	channel: 'instagram',
	enabled: true,
	status: 'draft',
	scheduled_at: null,
	overrides: {},
}

const hero: PostMedia = {
	id: 'm1',
	post_id: 'p1',
	url: 'https://cdn.example/hero.jpg',
	role: 'hero',
	position: 0,
	alt: null,
}

function bodyWithSections(n: number): string {
	let html = ''
	for (let i = 0; i < n; i++) html += `<h2>Section ${i}</h2><p>Body ${i}</p>`
	return html
}

describe('renderSlidePng', () => {
	it('renders a cover slide to PNG bytes (PNG magic header)', async () => {
		const png = await renderSlidePng({ brandTokens: brand, slide: coverSlide() })
		expect(png).toBeInstanceOf(Uint8Array)
		expect(png.length).toBeGreaterThan(8)
		expect(Array.from(png.subarray(0, 8))).toEqual(PNG_MAGIC)
	})
})

describe('renderCarousel', () => {
	it('renders one PNG per slide and caps an 11-section post at 10 with a warning', async () => {
		// 11 sections => cover + 11 content + cta = 13 raw => capped to 10.
		const result = await renderCarousel(post(bodyWithSections(11)), [hero], channel, brand)
		expect(result.pngs).toHaveLength(IG_MAX_SLIDES)
		result.pngs.forEach((png) => {
			expect(Array.from(png.subarray(0, 8))).toEqual(PNG_MAGIC)
		})
		expect(result.warnings.some((w) => /truncated to 10 slides/.test(w))).toBe(true)
	}, 30000)
})
