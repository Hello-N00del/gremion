// @vitest-environment node
// Unit tests for drainScheduledPublishes — the scheduled-publish worker tick.
// content-db's getDb() (the due-rows SELECT) and publishPost are both mocked, so
// this is a pure-logic unit test (no Postgres). It asserts: due rows are
// drained; a throwing row does NOT abort the others; and the SELECT predicate is
// trusted (the worker publishes exactly the rows the query returns — not-due /
// disabled / non-scheduled rows simply never come back from the mock and so are
// never published).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const dueRows = vi.fn<() => Promise<unknown[]>>()
const publishPost = vi.fn()
const isInstagramConfigured = vi.fn<() => Promise<boolean>>()

// getDb() returns a tagged-template `sql` function; the worker issues exactly one
// query, so the template fn captures the SQL fragments (to assert the due-query
// predicate) and resolves whatever `dueRows()` yields.
const sqlFragments: string[] = []
vi.mock('../db', () => ({
	getDb: () => (strings: TemplateStringsArray, ...args: unknown[]) => {
		sqlFragments.push(strings.join(''))
		sqlArgs.push(args)
		return dueRows()
	},
}))

vi.mock('./publish', () => ({
	publishPost: (...a: unknown[]) => publishPost(...a),
}))

// The IG-exclusion is now gated on isInstagramConfigured() — mocked so the
// disabled (default) and configured (activation) branches are both unit-tested.
vi.mock('./instagram/credentials', () => ({
	isInstagramConfigured: () => isInstagramConfigured(),
}))

// capture the interpolated args so the configured-branch test can assert the
// `${includeInstagram}` flag the worker passes into the due-query predicate.
const sqlArgs: unknown[][] = []

import { drainScheduledPublishes } from './worker'

beforeEach(() => {
	vi.clearAllMocks()
	sqlFragments.length = 0
	sqlArgs.length = 0
	publishPost.mockResolvedValue({ channel: 'email', status: 'sent', warnings: [] })
	isInstagramConfigured.mockResolvedValue(false)
})

describe('drainScheduledPublishes', () => {
	it('publishes every due row the query returns', async () => {
		dueRows.mockResolvedValue([
			{ post_id: 'p1', channel: 'email' },
			{ post_id: 'p2', channel: 'portal' },
		])

		await drainScheduledPublishes()

		expect(publishPost).toHaveBeenCalledTimes(2)
		expect(publishPost).toHaveBeenCalledWith('p1', 'email')
		expect(publishPost).toHaveBeenCalledWith('p2', 'portal')
	})

	it('does nothing when no rows are due (not-due / disabled / non-scheduled are filtered by the SELECT)', async () => {
		dueRows.mockResolvedValue([])

		await drainScheduledPublishes()

		expect(publishPost).not.toHaveBeenCalled()
	})

	it('excludes the instagram channel from the due-query when NOT configured (the shipping default)', async () => {
		isInstagramConfigured.mockResolvedValue(false)
		dueRows.mockResolvedValue([])

		await drainScheduledPublishes()

		// the SELECT keeps the instagram exclusion fragment, and the interpolated
		// includeInstagram flag is false → `(false OR channel <> 'instagram')`.
		const query = sqlFragments.join(' ')
		expect(query).toContain("channel <> 'instagram'")
		expect(sqlArgs[0]).toContain(false)
	})

	it('lifts the instagram exclusion when configured (passes includeInstagram=true into the due-query)', async () => {
		isInstagramConfigured.mockResolvedValue(true)
		dueRows.mockResolvedValue([])

		await drainScheduledPublishes()

		// the exclusion fragment is still in the SQL text, but the flag is true →
		// `(true OR channel <> 'instagram')` so scheduled IG rows are returned.
		expect(sqlArgs[0]).toContain(true)
	})

	it('a throwing row does not abort the others', async () => {
		dueRows.mockResolvedValue([
			{ post_id: 'p1', channel: 'email' },
			{ post_id: 'p2', channel: 'portal' },
			{ post_id: 'p3', channel: 'email' },
		])
		publishPost
			.mockResolvedValueOnce({ channel: 'email', status: 'sent', warnings: [] })
			.mockRejectedValueOnce(new Error('SMTP down'))
			.mockResolvedValueOnce({ channel: 'email', status: 'sent', warnings: [] })

		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		// must resolve, not reject, despite the middle row throwing
		await expect(drainScheduledPublishes()).resolves.toBeUndefined()

		expect(publishPost).toHaveBeenCalledTimes(3)
		expect(publishPost).toHaveBeenNthCalledWith(1, 'p1', 'email')
		expect(publishPost).toHaveBeenNthCalledWith(2, 'p2', 'portal')
		expect(publishPost).toHaveBeenNthCalledWith(3, 'p3', 'email')
		expect(errSpy).toHaveBeenCalledTimes(1)

		errSpy.mockRestore()
	})
})
