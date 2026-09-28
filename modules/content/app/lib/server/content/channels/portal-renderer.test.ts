// @vitest-environment node
// Unit tests for the portal channel renderer (L1 derive + L2 render/publish).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getPublication = vi.fn()
const setPublication = vi.fn()
const setChannelStatus = vi.fn()
const updateNewsBodyHtml = vi.fn()
const publishNewsPost = vi.fn()
const portalCallbackMock = vi.fn()

// A sentinel tx the first-publish path threads through every news-db/content-db
// call inside getDb().begin(...). The renderer wraps the create-path in a single
// transaction; the mock runs the callback synchronously with this tx and returns
// whatever it resolves (the externalRef), proving the path is committed atomically.
const TX = Symbol('tx')
const begin = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(TX))

vi.mock('../../db', () => ({
	getDb: () => ({ begin: (cb: (tx: unknown) => Promise<unknown>) => begin(cb) }),
}))

vi.mock('../content-db', () => ({
	getPublication: (...a: unknown[]) => getPublication(...a),
	setPublication: (...a: unknown[]) => setPublication(...a),
	setChannelStatus: (...a: unknown[]) => setChannelStatus(...a),
}))

vi.mock('$lib/server/news/news-db', () => ({
	updateNewsBodyHtml: (...a: unknown[]) => updateNewsBodyHtml(...a),
	publishNewsPost: (...a: unknown[]) => publishNewsPost(...a),
}))

// Task 9: portal-renderer delegates first-publish news-DB writes to portalCallback.
// Mock it here so the unit test doesn't exercise SQL (that is integration-test territory).
vi.mock('$lib/server/news/portal-callback', () => ({
	portalCallback: (...a: unknown[]) => portalCallbackMock(...a),
}))

import { portalRenderer } from './portal-renderer'
import type { Post, PostChannel } from '../types'

const channel: PostChannel = {
	post_id: 'p1',
	channel: 'portal',
	enabled: true,
	status: 'draft',
	scheduled_at: null,
	overrides: {},
}

function postWith(bodyHtml: string): Post {
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

beforeEach(() => {
	vi.clearAllMocks()
	setPublication.mockResolvedValue(undefined)
	setChannelStatus.mockResolvedValue({})
	updateNewsBodyHtml.mockResolvedValue(undefined)
	publishNewsPost.mockResolvedValue(undefined)
	// Default: portalCallback returns newsId=42
	portalCallbackMock.mockResolvedValue({
		newsId: 42,
		slug: 'hello-world',
		published_at: null,
		content_origin_post_id: 'p1',
	})
})

describe('portalRenderer.derive', () => {
	it('returns the title and sanitized body with no warnings', () => {
		const out = portalRenderer.derive(postWith('<p>Hello</p>'), [], channel)
		expect(out.title).toBe('Hello World')
		expect(out.html).toContain('<p>Hello</p>')
		expect(out.warnings).toEqual([])
	})

	it('re-sanitizes the body as defense-in-depth (strips script)', () => {
		const out = portalRenderer.derive(
			postWith('<p>ok</p><script>alert(1)</script>'),
			[],
			channel,
		)
		expect(out.html).not.toContain('<script>')
		expect(out.html).not.toContain('alert(1)')
		expect(out.html).toContain('<p>ok</p>')
	})

	it('is deterministic — calling twice is deep-equal', () => {
		const p = postWith('<p>x</p><h2>A</h2><p>y</p>')
		expect(portalRenderer.derive(p, [], channel)).toEqual(portalRenderer.derive(p, [], channel))
	})

	it('reports portal as its channel', () => {
		expect(portalRenderer.channel).toBe('portal')
	})
})

describe('portalRenderer.render', () => {
	it('returns the portal artifact with re-sanitized body', async () => {
		const out = await portalRenderer.render(
			postWith('<p>ok</p><script>alert(1)</script>'),
			[],
			channel,
		)
		expect(out.kind).toBe('portal')
		if (out.kind !== 'portal') throw new Error('expected portal artifact')
		expect(out.title).toBe('Hello World')
		expect(out.html).toContain('<p>ok</p>')
		expect(out.html).not.toContain('<script>')
		expect(out.html).not.toContain('alert(1)')
	})
})

describe('portalRenderer.publish', () => {
	it('first publish delegates to portalCallback and links the row — all in ONE tx', async () => {
		getPublication.mockResolvedValue(null)

		const out = await portalRenderer.publish(postWith('<p>body</p>'), [], channel)

		// the create-path runs inside a single getDb().begin transaction
		expect(begin).toHaveBeenCalledTimes(1)
		// portalCallback is called with the content post id and the tx
		expect(portalCallbackMock).toHaveBeenCalledTimes(1)
		expect(portalCallbackMock.mock.calls[0]![0]).toMatchObject({
			contentPostId: 'p1',
			title: 'Hello World',
			authorId: 'u1',
		})
		expect(portalCallbackMock.mock.calls[0]![1]).toBe(TX)
		// setPublication commits the link atomically inside the same tx
		expect(setPublication).toHaveBeenCalledWith('p1', 'portal', '42', TX)
		expect(setChannelStatus).toHaveBeenCalledWith('p1', 'portal', 'published')

		expect(out).toEqual({
			channel: 'portal',
			status: 'published',
			externalRef: '42',
			warnings: [],
		})
	})

	it('second publish reuses the same external_ref (no new portalCallback)', async () => {
		getPublication.mockResolvedValue({
			post_id: 'p1',
			channel: 'portal',
			external_ref: '42',
			published_at: '2026-06-29T00:00:00.000Z',
		})

		const out = await portalRenderer.publish(postWith('<p>updated</p>'), [], channel)

		expect(portalCallbackMock).not.toHaveBeenCalled()
		// re-publish is an idempotent update of an already-linked row → no tx wrap
		expect(begin).not.toHaveBeenCalled()
		expect(updateNewsBodyHtml).toHaveBeenCalledTimes(1)
		expect(updateNewsBodyHtml.mock.calls[0]![0]).toBe(42)
		expect(updateNewsBodyHtml.mock.calls[0]![1]).toContain('<p>updated</p>')
		expect(publishNewsPost).toHaveBeenCalledWith(42)
		// linkage already exists; setPublication need not be called again, but
		// status must be (re)set to published.
		expect(setChannelStatus).toHaveBeenCalledWith('p1', 'portal', 'published')

		expect(out).toEqual({
			channel: 'portal',
			status: 'published',
			externalRef: '42',
			warnings: [],
		})
	})

	it('re-sanitizes the body before passing it to portalCallback (first publish)', async () => {
		getPublication.mockResolvedValue(null)

		await portalRenderer.publish(
			postWith('<p>ok</p><script>alert(1)</script>'),
			[],
			channel,
		)

		const passedHtml = portalCallbackMock.mock.calls[0]![0].bodyHtml as string
		expect(passedHtml).toContain('<p>ok</p>')
		expect(passedHtml).not.toContain('<script>')
		expect(passedHtml).not.toContain('alert(1)')
	})
})
