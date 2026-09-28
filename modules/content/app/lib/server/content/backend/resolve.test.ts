import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'

// The inprocess client reads getTenant() on each method call (not at construction),
// so resolving the backend never touches tenant context — no mock needed for the
// happy path. We still stub it so any incidental read resolves the default tenant.
vi.mock('$lib/server/tenant/context', () => ({
  currentTenantId: () => 'default',
  getTenant: () => ({ id: 'default', slug: 'default' }),
  runWithTenant: (_ctx: unknown, fn: () => unknown) => fn(),
}))

import { resolveContentBackendOr503, resolveContentBackendForPage } from './resolve'

const savedEnv = process.env.CONTENT_BACKEND

beforeEach(() => {
  // Silence the intentional console.error from the 503 mapping path.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.CONTENT_BACKEND
  else process.env.CONTENT_BACKEND = savedEnv
  vi.restoreAllMocks()
})

describe('resolve helpers', () => {
  it('Or503 returns a backend when valid', () => {
    const r = resolveContentBackendOr503()
    expect(r instanceof Response).toBe(false)
  })
  it('Or503 returns a 503 Response when CONTENT_BACKEND is invalid', () => {
    process.env.CONTENT_BACKEND = 'nope'
    const r = resolveContentBackendOr503()
    expect(r instanceof Response).toBe(true)
    expect((r as Response).status).toBe(503)
  })
  it('ForPage throws a 503 when invalid', () => {
    process.env.CONTENT_BACKEND = 'nope'
    try {
      resolveContentBackendForPage()
      expect.unreachable('expected resolveContentBackendForPage to throw')
    } catch (err) {
      // SvelteKit error() throws an HttpError-shaped object: { status, body }.
      expect((err as { status?: number }).status).toBe(503)
    }
  })
})
