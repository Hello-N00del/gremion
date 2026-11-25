// news_posts.id is an int4 SERIAL. An id that is not a positive int4 ("1.5",
// "99999999999") used to pass `Number()` and reach the column, where the driver
// refused it and the caller got a 500. PATCH and DELETE answer 400 before any query.
import { beforeEach, describe, expect, test, vi } from 'vitest'

const { mockGet, mockDelete } = vi.hoisted(() => ({ mockGet: vi.fn(), mockDelete: vi.fn() }))

vi.mock('$lib/server/internal-fetch', () => ({ isInternalBearerRequest: () => true }))
vi.mock('$lib/auth', () => ({ hasRole: () => true, Role: { CouncilAdmin: 'council_admin' } }))
vi.mock('$lib/server/news/news-db', () => ({
	getNewsPostById: mockGet,
	updateNewsBodyHtml: vi.fn(),
	publishNewsPost: vi.fn(),
	unpublishNewsPost: vi.fn(),
	deleteNewsPost: mockDelete,
}))
vi.mock('$lib/server/security/html-sanitize', () => ({ sanitizeRichHtml: (s: string) => s }))

import { PATCH, DELETE } from './+server'

const BAD_IDS = ['1.5', '99999999999', '2147483648', 'abc', '0', '-1', '1e3']

function event(id: string, method: string): Parameters<typeof PATCH>[0] {
	return {
		request: new Request('http://stura.test/api/news/' + id, {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: method === 'DELETE' ? undefined : JSON.stringify({ action: 'publish' }),
		}),
		locals: { auth: async () => ({ user: { roles: ['council_admin'] } }) },
		params: { id },
	} as unknown as Parameters<typeof PATCH>[0]
}

beforeEach(() => {
	mockGet.mockReset().mockResolvedValue({ id: 1, title: 'T' })
	mockDelete.mockReset()
})

describe('/api/news/[id] with an id that is not a positive int4', () => {
	test.each(BAD_IDS)('PATCH %s answers 400 before any query', async (id) => {
		await expect(PATCH(event(id, 'PATCH'))).rejects.toMatchObject({ status: 400 })
		expect(mockGet).not.toHaveBeenCalled()
	})

	test.each(BAD_IDS)('DELETE %s answers 400 before any query', async (id) => {
		await expect(DELETE(event(id, 'DELETE') as Parameters<typeof DELETE>[0])).rejects.toMatchObject({ status: 400 })
		expect(mockGet).not.toHaveBeenCalled()
		expect(mockDelete).not.toHaveBeenCalled()
	})

	test('a valid id still reaches the query', async () => {
		await PATCH(event('1', 'PATCH'))
		expect(mockGet).toHaveBeenCalledWith(1)
	})
})
