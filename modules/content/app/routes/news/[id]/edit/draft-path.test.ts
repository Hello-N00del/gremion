// @vitest-environment node
// F1-FIX-07 H09 (K5#28) + S3#9: the news draft ODT on the SHARED Nextcloud is
// keyed by tenant, and an existing draft is never overwritten by an empty stub.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TENANT_A = '01900000-0000-7000-8000-00000000000a'
const TENANT_B = '01900000-0000-7000-8000-00000000000b'

const { nc, getTenant, getNewsPostById, createEmptyOdt } = vi.hoisted(() => ({
	nc: {
		mkcol: vi.fn(),
		getFileId: vi.fn(),
		upload: vi.fn(),
		download: vi.fn(),
		getCollaboraEditorUrl: vi.fn(),
	},
	getTenant: vi.fn(),
	getNewsPostById: vi.fn(),
	createEmptyOdt: vi.fn(),
}))

vi.mock('$lib/auth', () => ({
	hasRole: (roles: string[], required: string) => roles.includes(required),
	Role: { CouncilAdmin: 'council-admin' },
}))
vi.mock('$lib/server/tenant/context', () => ({ getTenant }))
vi.mock('$lib/server/news/news-db', () => ({
	getNewsPostById,
	updateNewsBodyHtml: vi.fn(),
}))
vi.mock('$lib/server/files/nextcloud-client', () => ({ createNextcloudClient: () => nc }))
vi.mock('$lib/server/newsletter/collabora-convert', () => ({
	createEmptyOdt,
	convertOdtToHtml: vi.fn(async () => '<p>x</p>'),
}))
vi.mock('$lib/server/security/html-sanitize', () => ({ sanitizeRichHtml: (s: string) => s }))
vi.mock('$lib/server/internal-fetch', () => ({ internalFetch: vi.fn() }))

import { load, actions } from './+page.server'

function notFound(): Error & { status: number } {
	return Object.assign(new Error('Nextcloud PROPFIND → 404'), { status: 404 })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function event(id = '7'): any {
	return {
		params: { id },
		locals: { auth: async () => ({ user: { roles: ['council-admin'], groups: [], id: 'u1' } }) },
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	nc.mkcol.mockResolvedValue(undefined)
	nc.upload.mockResolvedValue(undefined)
	nc.getCollaboraEditorUrl.mockResolvedValue({ editorUrl: 'https://office.example/e', tokenTtl: 1 })
	nc.download.mockResolvedValue(new Response(new Uint8Array([1, 2, 3])))
	getNewsPostById.mockResolvedValue({ id: 7, title: 'T' })
	createEmptyOdt.mockResolvedValue(new Uint8Array([0]))
	getTenant.mockReturnValue({ id: TENANT_A, slug: 'a' })
})

describe('news draft path is per tenant (H09)', () => {
	it('two tenants with the same SERIAL post id get different draft paths, each containing its tenant id', async () => {
		nc.getFileId.mockRejectedValueOnce(notFound()).mockResolvedValue(42)
		getTenant.mockReturnValue({ id: TENANT_A, slug: 'a' })
		await load(event('7'))
		const pathA = nc.upload.mock.calls[0]![0] as string

		nc.getFileId.mockReset().mockRejectedValueOnce(notFound()).mockResolvedValue(43)
		getTenant.mockReturnValue({ id: TENANT_B, slug: 'b' })
		await load(event('7'))
		const pathB = nc.upload.mock.calls[1]![0] as string

		expect(pathA).not.toBe(pathB)
		expect(pathA).toContain(TENANT_A)
		expect(pathB).toContain(TENANT_B)
		expect(pathA).toMatch(/\/news-posts\/[0-9a-f-]+\/drafts\/7\.odt$/)
	})

	it('the save action reads the draft from the tenant path, not the shared one', async () => {
		getTenant.mockReturnValue({ id: TENANT_B, slug: 'b' })
		await actions.save(event('7'))
		const path = nc.download.mock.calls[0]![0] as string
		expect(path).toContain(`/news-posts/${TENANT_B}/drafts/7.odt`)
	})
})

describe('an existing draft is never overwritten by an empty stub (S3#9)', () => {
	it('a non-404 lookup error (Nextcloud down) uploads NOTHING', async () => {
		nc.getFileId.mockRejectedValue(Object.assign(new Error('Nextcloud PROPFIND → 503'), { status: 503 }))
		const out = await load(event('7'))
		expect(nc.upload).not.toHaveBeenCalled()
		expect(out).toMatchObject({ editorUrl: null })
	})

	it('a lookup that cannot parse the fileId uploads NOTHING', async () => {
		nc.getFileId.mockRejectedValue(new Error('Could not parse fileId from PROPFIND response'))
		await load(event('7'))
		expect(nc.upload).not.toHaveBeenCalled()
	})

	it('a real 404 creates the stub exactly once, then opens the editor', async () => {
		nc.getFileId.mockRejectedValueOnce(notFound()).mockResolvedValue(42)
		const out = await load(event('7'))
		expect(nc.upload).toHaveBeenCalledTimes(1)
		expect(out).toMatchObject({ editorUrl: 'https://office.example/e' })
	})
})
