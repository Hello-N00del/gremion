// @vitest-environment node
// Unit tests for the Instagram channel renderer (L1 derive + L3 render/publish).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { instagramRenderer } from './instagram-renderer'
import { IG_MAX_SLIDES } from '../caption'
import type { Post, PostChannel, PostMedia } from '../types'

// The L3 publish() path is gated on the credentials seam + the outbox enqueue.
// Both are mocked here so the renderer's branching (configured vs not) is unit-
// tested without a Postgres or any real credentials.
vi.mock('../instagram/credentials', () => ({
	isInstagramConfigured: vi.fn(),
}))
vi.mock('../content-db', () => ({
	enqueuePublishOp: vi.fn(),
}))
import { isInstagramConfigured } from '../instagram/credentials'
import { enqueuePublishOp } from '../content-db'

function post(bodyHtml: string, title = 'Hello World'): Post {
	return {
		id: 'p1',
		slug: 'hello',
		title,
		body_html: bodyHtml,
		created_by: 'u1',
		created_at: '2026-06-29T00:00:00.000Z',
		updated_at: '2026-06-29T00:00:00.000Z',
	}
}

function channel(overrides: Record<string, unknown> = {}): PostChannel {
	return {
		post_id: 'p1',
		channel: 'instagram',
		enabled: true,
		status: 'draft',
		scheduled_at: null,
		overrides,
	}
}

const hero: PostMedia = {
	id: 'm1',
	post_id: 'p1',
	url: 'https://cdn.example/hero.jpg',
	role: 'hero',
	position: 0,
	alt: 'hero',
}

/** Build a body with exactly `n` <h2> sections (no lead). */
function bodyWithSections(n: number): string {
	let html = ''
	for (let i = 0; i < n; i++) html += `<h2>Section ${i}</h2><p>Body ${i}</p>`
	return html
}

describe('instagramRenderer.derive', () => {
	it('builds [cover, ...content per section, cta] with index/total stamped', () => {
		const out = instagramRenderer.derive(post('<h2>A</h2><p>alpha</p><h2>B</h2><p>beta</p>'), [hero], channel())
		// cover + 2 content + cta = 4 slides
		expect(out.slides).toHaveLength(4)
		expect(out.slides[0]).toMatchObject({ kind: 'cover', heading: 'Hello World', body: '', imageUrl: hero.url })
		expect(out.slides[1]).toMatchObject({ kind: 'content', heading: 'A', body: 'alpha' })
		expect(out.slides[2]).toMatchObject({ kind: 'content', heading: 'B', body: 'beta' })
		expect(out.slides[3]).toMatchObject({ kind: 'cta', heading: '', imageUrl: null })
		// index/total are consistent across the deck
		out.slides.forEach((s, i) => {
			expect(s.index).toBe(i)
			expect(s.total).toBe(4)
		})
		expect(out.caption).toContain('Hello World')
	})

	it('uses null cover image when there is no hero media', () => {
		const out = instagramRenderer.derive(post('<h2>A</h2><p>a</p>'), [], channel())
		expect(out.slides[0].imageUrl).toBeNull()
	})

	it('caps a >10-section post at IG_MAX_SLIDES slides and warns', () => {
		// 11 sections => cover + 11 content + cta = 13 raw slides => capped to 10.
		const out = instagramRenderer.derive(post(bodyWithSections(11)), [hero], channel())
		expect(out.slides).toHaveLength(IG_MAX_SLIDES)
		expect(out.slides.every((s) => s.total === IG_MAX_SLIDES)).toBe(true)
		expect(out.warnings.some((w) => /truncated to 10 slides/.test(w))).toBe(true)
	})

	it('applies overrides.slides last (overlay over derived defaults)', () => {
		const out = instagramRenderer.derive(
			post('<h2>A</h2><p>a</p>'),
			[hero],
			channel({ slides: [{ heading: 'Overridden Cover', imageUrl: null }] }),
		)
		expect(out.slides[0].heading).toBe('Overridden Cover')
		expect(out.slides[0].imageUrl).toBeNull()
		// non-overridden slide untouched
		expect(out.slides[1].heading).toBe('A')
	})

	it('applies an overrides.caption string last', () => {
		const out = instagramRenderer.derive(post('<h2>A</h2><p>a</p>'), [hero], channel({ caption: 'Custom caption' }))
		expect(out.caption).toBe('Custom caption')
	})

	it('is deterministic — calling twice is deep-equal', () => {
		const p = post('<p>intro</p><h2>A</h2><p>a</p><h2>B</h2><p>b</p>')
		const c = channel()
		expect(instagramRenderer.derive(p, [hero], c)).toEqual(instagramRenderer.derive(p, [hero], c))
	})

	it('reports instagram as its channel', () => {
		expect(instagramRenderer.channel).toBe('instagram')
	})
})

/** The 8-byte PNG signature satori/resvg emit. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

describe('instagramRenderer.render', () => {
	it('returns an InstagramArtifact with capped slide PNGs + caption', async () => {
		// 11 sections => cover + 11 content + cta = 13 raw => capped to 10.
		const out = await instagramRenderer.render(post(bodyWithSections(11)), [hero], channel())
		expect(out.kind).toBe('instagram')
		if (out.kind !== 'instagram') throw new Error('unreachable')
		expect(out.slides).toHaveLength(IG_MAX_SLIDES)
		expect(out.pngs).toHaveLength(IG_MAX_SLIDES)
		// each rendered slide is real PNG bytes
		out.pngs.forEach((png) => {
			expect(png).toBeInstanceOf(Uint8Array)
			expect(Array.from(png.subarray(0, 8))).toEqual(PNG_MAGIC)
		})
		expect(out.caption).toContain('Hello World')
	}, 30000)
})

describe('instagramRenderer.publish', () => {
	beforeEach(() => {
		vi.mocked(isInstagramConfigured).mockReset()
		vi.mocked(enqueuePublishOp).mockReset()
	})

	it('returns a disabled failed result and enqueues NOTHING when not configured', async () => {
		vi.mocked(isInstagramConfigured).mockResolvedValue(false)
		const out = await instagramRenderer.publish(post('<h2>A</h2><p>a</p>'), [hero], channel())
		expect(out).toMatchObject({ channel: 'instagram', status: 'failed' })
		expect(out.detail).toMatch(/not configured/i)
		expect(enqueuePublishOp).not.toHaveBeenCalled()
	})

	it('enqueues an outbox op and returns scheduled when configured', async () => {
		vi.mocked(isInstagramConfigured).mockResolvedValue(true)
		vi.mocked(enqueuePublishOp).mockResolvedValue(undefined)
		const p = post('<h2>A</h2><p>a</p>')
		const out = await instagramRenderer.publish(p, [hero], channel())
		expect(out).toMatchObject({ channel: 'instagram', status: 'scheduled' })
		expect(enqueuePublishOp).toHaveBeenCalledExactlyOnceWith(p.id)
		// the composed caption's warnings ride along
		expect(Array.isArray(out.warnings)).toBe(true)
	})
})
