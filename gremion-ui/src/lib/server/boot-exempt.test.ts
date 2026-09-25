import { describe, it, expect } from 'vitest'
import { BOOT_AND_RESOLVE_EXEMPT_PATHS, isBootAndResolveExempt, isResolveExemptRequest } from './boot-exempt'

/**
 * TASK-023 (B-05 option 1): the CLOSED allow-list of paths that skip BOTH the
 * tenant resolver and the process-wide boot 503. Every entry is a request that
 * reaches a handler with no tenant context and before boot completes, so the
 * list is pinned by value: adding a third entry must turn this RED and force
 * the addition through review.
 */
describe('BOOT_AND_RESOLVE_EXEMPT_PATHS', () => {
  it('is exactly the two B-05 entries, in order', () => {
    expect([...BOOT_AND_RESOLVE_EXEMPT_PATHS]).toEqual(['/healthz', '/api/internal/'])
  })

  it('is frozen, so no module can widen it at runtime', () => {
    expect(Object.isFrozen(BOOT_AND_RESOLVE_EXEMPT_PATHS)).toBe(true)
    expect(() => (BOOT_AND_RESOLVE_EXEMPT_PATHS as string[]).push('/x')).toThrow(TypeError)
  })
})

describe('isBootAndResolveExempt', () => {
  it('matches an entry without a trailing slash exactly', () => {
    expect(isBootAndResolveExempt('/healthz')).toBe(true)
  })

  it('treats an entry ending in / as a prefix', () => {
    expect(isBootAndResolveExempt('/api/internal/evict')).toBe(true)
    expect(isBootAndResolveExempt('/api/internal/a/b')).toBe(true)
  })

  it('does not match a path that merely extends an entry', () => {
    expect(isBootAndResolveExempt('/healthzx')).toBe(false)
    expect(isBootAndResolveExempt('/api/internalx')).toBe(false)
    expect(isBootAndResolveExempt('/api/internalx/evict')).toBe(false)
  })

  it('does not treat an exact entry as a prefix, nor a prefix entry as exact', () => {
    expect(isBootAndResolveExempt('/healthz/')).toBe(false)
    expect(isBootAndResolveExempt('/healthz/deep')).toBe(false)
    expect(isBootAndResolveExempt('/api/internal')).toBe(false)
  })

  it('does not match unrelated or near-miss paths', () => {
    for (const p of ['/', '', '/api/health', '/api/healthz', '/HEALTHZ', '/x/healthz', '/api/public/internal/']) {
      expect(isBootAndResolveExempt(p), p).toBe(false)
    }
  })
})

describe('isResolveExemptRequest', () => {
  const none = new Headers()
  const host = new Headers({ 'x-forwarded-host': 'tenant.example.org' })
  const id = new Headers({ 'x-tenant-id': 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' })

  it('/healthz is exempt whatever it carries (it reads the host itself)', () => {
    expect(isResolveExemptRequest('/healthz', none)).toBe(true)
    expect(isResolveExemptRequest('/healthz', host)).toBe(true)
    expect(isResolveExemptRequest('/healthz', id)).toBe(true)
  })

  it('an /api/internal/ request that names no tenant is exempt', () => {
    expect(isResolveExemptRequest('/api/internal/evict', none)).toBe(true)
  })

  it('an /api/internal/ request that names a tenant is resolved (leaf callbacks, internalFetch hops, the edge)', () => {
    expect(isResolveExemptRequest('/api/internal/evict', host)).toBe(false)
    expect(isResolveExemptRequest('/api/internal/newsletter/render', id)).toBe(false)
  })

  it('a path off the list is never exempt', () => {
    expect(isResolveExemptRequest('/api/health', none)).toBe(false)
    expect(isResolveExemptRequest('/healthzx', none)).toBe(false)
  })
})
