// gremion-ui/src/lib/server/newsletter/backend/resolve.test.ts
// Task 13 — graceful-503 contract for the newsletter backend resolver.
//
// Task 23 (old-path decommission): the SQLite backend is removed. The default
// (NEWSLETTER_BACKEND unset) and 'service' now BOTH return a ServiceNewsletterClient;
// an UNKNOWN value throws in getNewsletterBackend() and the resolver maps that
// throw to a graceful 503. This suite pins:
//   1. resolveNewsletterBackendOr503() → 503 Response on construction error
//   2. resolveNewsletterBackendForPage() → throws error(503) on construction error
//   3. Both helpers return the real ServiceNewsletterClient when configured
//   4. The factory default (env unset) and NEWSLETTER_BACKEND=service both
//      resolve to ServiceNewsletterClient; an unknown value throws.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The service client reads getTenant() on each method call (not at construction),
// so resolving the backend never touches tenant context — no mock needed for the
// happy path. We still stub it so any incidental read resolves the default tenant.
vi.mock('$lib/server/tenant/context', () => ({
  currentTenantId: () => 'default',
  getTenant: () => ({ id: 'default', slug: 'default' }),
  runWithTenant: (_ctx: unknown, fn: () => unknown) => fn(),
}))

import {
  resolveNewsletterBackendOr503,
  resolveNewsletterBackendForPage,
} from './resolve'
import { ServiceNewsletterClient } from './service-client'
import { getNewsletterBackend } from './index'

const savedEnv = process.env.NEWSLETTER_BACKEND

beforeEach(() => {
  // Silence the intentional console.error from the 503 mapping path.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.NEWSLETTER_BACKEND
  else process.env.NEWSLETTER_BACKEND = savedEnv
  vi.restoreAllMocks()
})

describe('resolveNewsletterBackendOr503 — unknown backend is a graceful 503', () => {
  it('returns a 503 Response (with Retry-After) when NEWSLETTER_BACKEND=invalid-backend', () => {
    process.env.NEWSLETTER_BACKEND = 'invalid-backend'
    const result = resolveNewsletterBackendOr503()
    expect(result).toBeInstanceOf(Response)
    const res = result as Response
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('30')
  })

  it('does NOT throw for an unknown backend (no 500 / uncaught)', () => {
    process.env.NEWSLETTER_BACKEND = 'invalid-backend'
    expect(() => resolveNewsletterBackendOr503()).not.toThrow()
  })

  it('default mode (env unset) returns a ServiceNewsletterClient, not a Response', () => {
    delete process.env.NEWSLETTER_BACKEND
    const result = resolveNewsletterBackendOr503()
    expect(result).not.toBeInstanceOf(Response)
    expect(result).toBeInstanceOf(ServiceNewsletterClient)
  })

  it('service mode returns a ServiceNewsletterClient', () => {
    process.env.NEWSLETTER_BACKEND = 'service'
    const result = resolveNewsletterBackendOr503()
    expect(result).not.toBeInstanceOf(Response)
    expect(result).toBeInstanceOf(ServiceNewsletterClient)
  })
})

describe('resolveNewsletterBackendForPage — unknown backend throws error(503)', () => {
  it('throws a SvelteKit error with status 503 when NEWSLETTER_BACKEND=invalid-backend', () => {
    process.env.NEWSLETTER_BACKEND = 'invalid-backend'
    try {
      resolveNewsletterBackendForPage()
      expect.unreachable('expected resolveNewsletterBackendForPage to throw')
    } catch (err) {
      // SvelteKit error() throws an HttpError-shaped object: { status, body }.
      expect((err as { status?: number }).status).toBe(503)
    }
  })

  it('default mode (env unset) returns a ServiceNewsletterClient', () => {
    delete process.env.NEWSLETTER_BACKEND
    expect(resolveNewsletterBackendForPage()).toBeInstanceOf(ServiceNewsletterClient)
  })
})

// ── Factory flag contract (Task 23: default → service; unknown → throw) ───────
describe('getNewsletterBackend() factory', () => {
  it('returns a ServiceNewsletterClient when NEWSLETTER_BACKEND is unset', () => {
    delete process.env.NEWSLETTER_BACKEND
    expect(getNewsletterBackend()).toBeInstanceOf(ServiceNewsletterClient)
  })

  it('returns a ServiceNewsletterClient when NEWSLETTER_BACKEND=service', () => {
    process.env.NEWSLETTER_BACKEND = 'service'
    expect(getNewsletterBackend()).toBeInstanceOf(ServiceNewsletterClient)
  })

  it('throws on the removed sqlite value (decommissioned)', () => {
    process.env.NEWSLETTER_BACKEND = 'sqlite'
    expect(() => getNewsletterBackend()).toThrow(/Unknown NEWSLETTER_BACKEND/)
  })

  it('throws on any unknown backend value', () => {
    process.env.NEWSLETTER_BACKEND = 'unknown-backend'
    expect(() => getNewsletterBackend()).toThrow(/Unknown NEWSLETTER_BACKEND/)
  })
})
