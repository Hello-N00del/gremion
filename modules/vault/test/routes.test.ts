// services/vault/test/routes.test.ts
// Route-table contract (PG-free): buildApiRoutes() must expose EXACTLY the pinned
// vault endpoint set, and the router must extract their path params. Also pins the
// guard-EXEMPT health probes (/health and /healthz) via isHealthPath. The store is
// never touched here (the injected storeFn throws if a handler is dispatched) —
// handler behaviour is covered by api.integration.test.ts against a real Postgres.
import { describe, it, expect } from 'vitest'
import { buildApiRoutes } from '../src/http/routes.ts'
import { createRouter } from '../src/http/router.ts'
import { isHealthPath } from '../src/http/guard.ts'
import type { Sql, TenantRef } from '../src/store/index.ts'

const storeThatThrows = (_t: TenantRef): Promise<Sql> => {
  throw new Error('store must not be reached in a routing-only test')
}
const DUMMY_KEY = Buffer.alloc(32)

const routes = buildApiRoutes(storeThatThrows, DUMMY_KEY)
const router = createRouter(routes)

describe('vault leaf route table — exact endpoint set', () => {
  it('registers exactly the pinned vault endpoints', () => {
    const set = routes.map((r) => `${r.method} ${r.path}`).sort()
    expect(set).toEqual(
      [
        'GET /items',
        'POST /items',
        'GET /items/:id',
        'PUT /items/:id',
        'GET /items/:id/secret',
        'DELETE /items/:id',
        'GET /access-log',
      ].sort(),
    )
  })
})

describe('vault leaf health probes — guard-exempt /health and /healthz', () => {
  it('exempts /health', () => {
    expect(isHealthPath('/health')).toBe(true)
  })
  it('exempts /healthz', () => {
    expect(isHealthPath('/healthz')).toBe(true)
  })
  it('does NOT exempt a real API path', () => {
    expect(isHealthPath('/items')).toBe(false)
  })
})

describe('vault leaf router — path-param matching', () => {
  it('matches GET /items (list)', () => {
    expect(router.match('GET', '/items').type).toBe('matched')
  })

  it('extracts :id for GET /items/:id', () => {
    const m = router.match('GET', '/items/i-42')
    expect(m.type).toBe('matched')
    if (m.type !== 'matched') throw new Error('unreachable')
    expect(m.params).toEqual({ id: 'i-42' })
  })

  it('extracts :id for GET /items/:id/secret', () => {
    const m = router.match('GET', '/items/i-7/secret')
    expect(m.type).toBe('matched')
    if (m.type !== 'matched') throw new Error('unreachable')
    expect(m.params).toEqual({ id: 'i-7' })
  })

  it('does NOT let GET /items/:id/secret fall through to GET /items/:id', () => {
    // The secret subresource is a distinct, more-specific regex — it must win.
    const secret = router.match('GET', '/items/i-9/secret')
    expect(secret.type).toBe('matched')
    if (secret.type !== 'matched') throw new Error('unreachable')
    expect(secret.params).toEqual({ id: 'i-9' })
    const meta = router.match('GET', '/items/i-9')
    expect(meta.type).toBe('matched')
    if (meta.type !== 'matched') throw new Error('unreachable')
    expect(meta.params).toEqual({ id: 'i-9' })
  })

  it('extracts :id for DELETE /items/:id', () => {
    const m = router.match('DELETE', '/items/i-3')
    expect(m.type).toBe('matched')
    if (m.type !== 'matched') throw new Error('unreachable')
    expect(m.params).toEqual({ id: 'i-3' })
  })

  it('extracts :id for PUT /items/:id', () => {
    const m = router.match('PUT', '/items/i-5')
    expect(m.type).toBe('matched')
    if (m.type !== 'matched') throw new Error('unreachable')
    expect(m.params).toEqual({ id: 'i-5' })
  })

  it('matches GET /access-log (reveal-audit read)', () => {
    expect(router.match('GET', '/access-log').type).toBe('matched')
  })

  it('returns method-not-allowed for PUT on the list path', () => {
    const m = router.match('PUT', '/items')
    expect(m.type).toBe('method-not-allowed')
    if (m.type !== 'method-not-allowed') throw new Error('unreachable')
    expect(m.allowed).toContain('GET')
    expect(m.allowed).toContain('POST')
  })

  it('returns method-not-allowed for POST on /access-log (read-only, append happens on reveal)', () => {
    const m = router.match('POST', '/access-log')
    expect(m.type).toBe('method-not-allowed')
    if (m.type !== 'method-not-allowed') throw new Error('unreachable')
    expect(m.allowed).toContain('GET')
  })

  it('returns not-found for an unregistered path', () => {
    expect(router.match('GET', '/nope').type).toBe('not-found')
  })
})
