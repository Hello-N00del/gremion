// @vitest-environment node
// news_posts.id is an int4 SERIAL. An id that is not a positive int4 ("1.5",
// "99999999999") used to pass `Number()` and reach the column, where the driver
// refused it and the caller got a 500. The editor page and its actions answer 400
// before any query or internal call.
import { beforeEach, describe, expect, test, vi } from 'vitest'

const { getNewsPostById, internalFetch } = vi.hoisted(() => ({
	getNewsPostById: vi.fn(),
	internalFetch: vi.fn(),
}))

vi.mock('$lib/auth', () => ({
	hasRole: (roles: string[], required: string) => roles.includes(required),
	Role: { CouncilAdmin: 'council-admin' },
}))
vi.mock('$lib/server/tenant/context', () => ({ getTenant: () => ({ id: 'tenant-a', slug: 'a' }) }))
vi.mock('$lib/server/news/news-db', () => ({ getNewsPostById, updateNewsBodyHtml: vi.fn() }))
vi.mock('$lib/server/files/nextcloud-client', () => ({ createNextcloudClient: () => ({}) }))
vi.mock('$lib/server/newsletter/collabora-convert', () => ({
	createEmptyOdt: vi.fn(),
	convertOdtToHtml: vi.fn(),
}))
vi.mock('$lib/server/security/html-sanitize', () => ({ sanitizeRichHtml: (s: string) => s }))
vi.mock('$lib/server/internal-fetch', () => ({ internalFetch }))

import { load, actions } from './+page.server'

const BAD_IDS = ['1.5', '99999999999', '2147483648', 'abc', '0', '-1', '1e3']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function event(id: string): any {
	return {
		params: { id },
		url: new URL('https://rat.example.test/news/' + id + '/edit'),
		request: new Request('https://rat.example.test/x', { method: 'POST', body: new FormData() }),
		locals: { auth: async () => ({ user: { roles: ['council-admin'], groups: [], id: 'u1' } }) },
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	getNewsPostById.mockResolvedValue({ id: 7, title: 'T' })
})

describe('news editor with an id that is not a positive int4', () => {
	test.each(BAD_IDS)('load(%s) answers 400 before any query', async (id) => {
		await expect(load(event(id))).rejects.toMatchObject({ status: 400 })
		expect(getNewsPostById).not.toHaveBeenCalled()
	})

	test.each(BAD_IDS)('save(%s) answers 400 before any query', async (id) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await expect((actions.save as any)(event(id))).rejects.toMatchObject({ status: 400 })
		expect(getNewsPostById).not.toHaveBeenCalled()
	})

	test.each(BAD_IDS)('publish(%s) answers 400 before the internal call', async (id) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await expect((actions.publish as any)(event(id))).rejects.toMatchObject({ status: 400 })
		expect(internalFetch).not.toHaveBeenCalled()
	})

	test.each(BAD_IDS)('unpublish(%s) answers 400 before the internal call', async (id) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await expect((actions.unpublish as any)(event(id))).rejects.toMatchObject({ status: 400 })
		expect(internalFetch).not.toHaveBeenCalled()
	})
})
