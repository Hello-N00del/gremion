// @vitest-environment node
// Unit tests for the deterministic IG caption composer. `node` env: composeCaption
// builds its own jsdom window for tag-stripping, so we avoid the global DOM.
import { describe, it, expect } from 'vitest'
import { composeCaption, IG_CAPTION_MAX, IG_MAX_SLIDES } from './caption'
import type { Section } from './segment'
import type { Post } from './types'

function makePost(overrides: Partial<Post> = {}): Post {
	return {
		id: 'p1',
		slug: 'a-post',
		title: 'Weekly Update',
		body_html: '',
		created_by: 'u1',
		created_at: '2026-06-29T00:00:00.000Z',
		updated_at: '2026-06-29T00:00:00.000Z',
		...overrides,
	}
}

describe('caption caps', () => {
	it('exports the locked IG caps', () => {
		expect(IG_CAPTION_MAX).toBe(2200)
		expect(IG_MAX_SLIDES).toBe(10)
	})
})

describe('composeCaption', () => {
	it('composes title + blank line + plain-text lead + a handle/CTA line', () => {
		const post = makePost({ title: 'Hello World' })
		const sections: Section[] = [
			{ heading: '', html: '<p>This is the <strong>lead</strong> text.</p>' },
		]
		const { caption, warnings } = composeCaption(post, sections)
		expect(warnings).toEqual([])
		const blocks = caption.split('\n\n')
		expect(blocks[0]).toBe('Hello World')
		expect(blocks[1]).toBe('This is the lead text.')
		// Last block is the handle/CTA line.
		expect(blocks[blocks.length - 1].length).toBeGreaterThan(0)
		expect(blocks).toHaveLength(3)
		expect(caption).not.toContain('<')
	})

	it('truncates a caption over the cap on a word boundary with an ellipsis and warns', () => {
		const longLead = 'word '.repeat(600).trim() // ~2999 chars, > 2200
		const post = makePost({ title: 'T' })
		const sections: Section[] = [{ heading: '', html: `<p>${longLead}</p>` }]
		const { caption, warnings } = composeCaption(post, sections)
		expect(caption.length).toBeLessThanOrEqual(IG_CAPTION_MAX)
		expect(caption.endsWith('…')).toBe(true)
		// Word-boundary cut: the body (sans ellipsis) ends on a complete word,
		// i.e. the final retained token is the whole 4-letter word "word", never a
		// fragment like "wo" or a dangling space.
		const body = caption.slice(0, -1)
		expect(body.endsWith(' ')).toBe(false)
		expect(body.endsWith('word')).toBe(true)
		expect(warnings.some((w) => /truncat/i.test(w))).toBe(true)
	})

	it('does not warn or truncate when the caption is within the cap', () => {
		const post = makePost({ title: 'Short' })
		const sections: Section[] = [{ heading: '', html: '<p>Tiny lead.</p>' }]
		const { caption, warnings } = composeCaption(post, sections)
		expect(warnings).toEqual([])
		expect(caption.length).toBeLessThanOrEqual(IG_CAPTION_MAX)
		expect(caption.endsWith('…')).toBe(false)
	})

	it('omits the lead block gracefully when there are no sections', () => {
		const post = makePost({ title: 'Only Title' })
		const { caption, warnings } = composeCaption(post, [])
		expect(warnings).toEqual([])
		expect(caption.split('\n\n')[0]).toBe('Only Title')
	})
})
