// @vitest-environment node
// Unit tests for drainInstagramPublishOps — the L3 Instagram outbox drain.
//
// content-db (the outbox + post/media/channel reads), the credentials seam, the
// instagram renderer, and the Meta adapter are ALL mocked, so this is pure-logic
// (no Postgres, no network). It asserts: INERT when not configured (no DB touch);
// when configured, a due op renders → the NotConfigured slide-host seam marks it
// failed; the adapter happy-path marks it ok; missing post/channel mark failed;
// and per-row isolation (a throwing op never aborts the rest).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const listDuePublishOps = vi.fn<() => Promise<unknown[]>>()
const getPost = vi.fn()
const listMedia = vi.fn()
const getChannels = vi.fn()
const markPublishOpOk = vi.fn()
const markPublishOpFailed = vi.fn()
const isInstagramConfigured = vi.fn<() => Promise<boolean>>()
const resolveInstagramCredentials = vi.fn()
const render = vi.fn()
const publishCarousel = vi.fn()

vi.mock('../content-db', () => ({
	listDuePublishOps: () => listDuePublishOps(),
	getPost: (...a: unknown[]) => getPost(...a),
	listMedia: (...a: unknown[]) => listMedia(...a),
	getChannels: (...a: unknown[]) => getChannels(...a),
	markPublishOpOk: (...a: unknown[]) => markPublishOpOk(...a),
	markPublishOpFailed: (...a: unknown[]) => markPublishOpFailed(...a),
}))
vi.mock('./credentials', () => ({
	isInstagramConfigured: () => isInstagramConfigured(),
	resolveInstagramCredentials: () => resolveInstagramCredentials(),
}))
vi.mock('../channels/instagram-renderer', () => ({
	instagramRenderer: { render: (...a: unknown[]) => render(...a) },
}))
vi.mock('./adapter', () => ({
	createInstagramAdapter: () => ({ publishCarousel: (...a: unknown[]) => publishCarousel(...a) }),
}))

import { drainInstagramPublishOps } from './drain'

const CREDS = { accessToken: 'tok', igUserId: 'ig-1' }

/** A rendered instagram artifact with `n` slide PNGs. */
function artifact(n = 3) {
	return {
		kind: 'instagram' as const,
		slides: Array.from({ length: n }, (_, i) => ({ kind: 'cover', heading: '', body: '', imageUrl: null, index: i, total: n })),
		caption: 'a caption',
		pngs: Array.from({ length: n }, () => new Uint8Array([0x89, 0x50])),
	}
}

function igChannel() {
	return { post_id: 'p1', channel: 'instagram', enabled: true, status: 'scheduled', scheduled_at: null, overrides: {} }
}

beforeEach(() => {
	vi.clearAllMocks()
	isInstagramConfigured.mockResolvedValue(true)
	resolveInstagramCredentials.mockResolvedValue(CREDS)
	getPost.mockResolvedValue({ id: 'p1', title: 'T', body_html: '<h2>A</h2>' })
	listMedia.mockResolvedValue([])
	getChannels.mockResolvedValue([igChannel()])
	render.mockResolvedValue(artifact())
	publishCarousel.mockResolvedValue({ mediaId: 'meta-123' })
	markPublishOpOk.mockResolvedValue(undefined)
	markPublishOpFailed.mockResolvedValue(undefined)
})

describe('drainInstagramPublishOps', () => {
	it('is INERT when not configured — no ops listed, no row touched', async () => {
		isInstagramConfigured.mockResolvedValue(false)

		await drainInstagramPublishOps()

		expect(listDuePublishOps).not.toHaveBeenCalled()
		expect(getPost).not.toHaveBeenCalled()
		expect(markPublishOpOk).not.toHaveBeenCalled()
		expect(markPublishOpFailed).not.toHaveBeenCalled()
	})

	it('does nothing when configured but no ops are due', async () => {
		listDuePublishOps.mockResolvedValue([])

		await drainInstagramPublishOps()

		expect(render).not.toHaveBeenCalled()
		expect(markPublishOpOk).not.toHaveBeenCalled()
		expect(markPublishOpFailed).not.toHaveBeenCalled()
	})

	it('marks a due op FAILED via the NotConfigured slide-host seam (no public host in the disabled build)', async () => {
		listDuePublishOps.mockResolvedValue([{ id: 'op1', post_id: 'p1' }])

		await drainInstagramPublishOps()

		// rendered, but the slide-host seam returns null → adapter never called
		expect(render).toHaveBeenCalledOnce()
		expect(publishCarousel).not.toHaveBeenCalled()
		expect(markPublishOpFailed).toHaveBeenCalledWith('op1', 'slide hosting not configured')
		expect(markPublishOpOk).not.toHaveBeenCalled()
	})

	it('publishes via the adapter and marks OK when a slide-URL producer yields URLs', async () => {
		listDuePublishOps.mockResolvedValue([{ id: 'op1', post_id: 'p1' }])
		// inject an activation-style producer that turns each PNG into a public URL
		const producer = vi.fn((pngs: Uint8Array[]) => pngs.map((_, i) => ({ imageUrl: `https://host/slide-${i}.png` })))

		await drainInstagramPublishOps(producer)

		expect(producer).toHaveBeenCalledOnce()
		expect(publishCarousel).toHaveBeenCalledOnce()
		const [credsArg, slidesArg, captionArg] = publishCarousel.mock.calls[0]!
		expect(credsArg).toEqual(CREDS)
		expect(slidesArg).toHaveLength(3)
		expect(captionArg).toBe('a caption')
		expect(markPublishOpOk).toHaveBeenCalledWith('op1', 'meta-123')
		expect(markPublishOpFailed).not.toHaveBeenCalled()
	})

	it('marks FAILED when the adapter publish throws', async () => {
		listDuePublishOps.mockResolvedValue([{ id: 'op1', post_id: 'p1' }])
		const producer = () => [{ imageUrl: 'https://host/s.png' }]
		publishCarousel.mockRejectedValue(new Error('Instagram Graph media_publish failed: boom'))
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		await drainInstagramPublishOps(producer)

		expect(markPublishOpOk).not.toHaveBeenCalled()
		expect(markPublishOpFailed).toHaveBeenCalledWith('op1', 'Instagram Graph media_publish failed: boom')
		errSpy.mockRestore()
	})

	it('marks FAILED when the post no longer exists (without rendering)', async () => {
		listDuePublishOps.mockResolvedValue([{ id: 'op1', post_id: 'gone' }])
		getPost.mockResolvedValue(null)

		await drainInstagramPublishOps()

		expect(render).not.toHaveBeenCalled()
		expect(markPublishOpFailed).toHaveBeenCalledWith('op1', 'post no longer exists')
	})

	it('marks FAILED when the instagram channel row is missing', async () => {
		listDuePublishOps.mockResolvedValue([{ id: 'op1', post_id: 'p1' }])
		getChannels.mockResolvedValue([{ post_id: 'p1', channel: 'email', enabled: true, status: 'draft', scheduled_at: null, overrides: {} }])

		await drainInstagramPublishOps()

		expect(render).not.toHaveBeenCalled()
		expect(markPublishOpFailed).toHaveBeenCalledWith('op1', 'instagram channel row missing')
	})

	it('per-row isolation: a throwing op is marked failed and the next op still runs', async () => {
		listDuePublishOps.mockResolvedValue([
			{ id: 'op1', post_id: 'p1' },
			{ id: 'op2', post_id: 'p2' },
		])
		// op1 render throws; op2 renders fine but the slide-host seam fails it.
		render.mockRejectedValueOnce(new Error('render boom'))
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		await expect(drainInstagramPublishOps()).resolves.toBeUndefined()

		expect(markPublishOpFailed).toHaveBeenCalledWith('op1', 'render boom')
		// op2 was still attempted (rendered) after op1 threw
		expect(render).toHaveBeenCalledTimes(2)
		expect(markPublishOpFailed).toHaveBeenCalledWith('op2', 'slide hosting not configured')

		errSpy.mockRestore()
	})
})
