// @vitest-environment node
// Unit tests for the pure <h2> segmenter. Runs in `node` env: segmentBody
// constructs its own jsdom window internally, so the test must not depend on
// (or be polluted by) the suite-default global jsdom DOM.
import { describe, it, expect } from 'vitest'
import { segmentBody, type Section } from './segment'

describe('segmentBody', () => {
	it('splits an intro plus two <h2> sections into lead + two sections', () => {
		const html =
			'<p>Welcome to the update.</p>' +
			'<h2>First</h2><p>Alpha</p>' +
			'<h2>Second</h2><p>Beta</p>'
		const sections = segmentBody(html)
		expect(sections).toHaveLength(3)
		expect(sections[0].heading).toBe('')
		expect(sections[0].html).toBe('<p>Welcome to the update.</p>')
		expect(sections[1]).toEqual<Section>({ heading: 'First', html: '<p>Alpha</p>' })
		expect(sections[2]).toEqual<Section>({ heading: 'Second', html: '<p>Beta</p>' })
	})

	it('returns a single lead section when there is no <h2>', () => {
		const html = '<p>One block</p><ul><li>x</li></ul>'
		const sections = segmentBody(html)
		expect(sections).toHaveLength(1)
		expect(sections[0].heading).toBe('')
		expect(sections[0].html).toBe('<p>One block</p><ul><li>x</li></ul>')
	})

	it('uses the flattened text content of an <h2> with nested inline tags as the heading', () => {
		const html = '<h2>Hello <em>brave</em> <strong>world</strong></h2><p>body</p>'
		const sections = segmentBody(html)
		expect(sections).toHaveLength(1)
		expect(sections[0].heading).toBe('Hello brave world')
		expect(sections[0].html).toBe('<p>body</p>')
	})

	it('returns [] for an empty or whitespace-only body', () => {
		expect(segmentBody('')).toEqual([])
		expect(segmentBody('   \n  ')).toEqual([])
	})

	it('is deterministic — same input yields deep-equal output', () => {
		const html = '<p>intro</p><h2>A</h2><p>a</p><h2>B</h2><p>b</p>'
		expect(segmentBody(html)).toEqual(segmentBody(html))
	})
})
