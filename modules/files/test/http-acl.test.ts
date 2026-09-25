// services/files/test/http-acl.test.ts
// The files leaf is internal-only: every /api/v1/* route requires a constant-time
// x-internal-auth secret (timingSafeEqual) + tenant headers; /healthz is exempt.
// This mirrors services/content/src/http guard tests and adds an end-to-end
// node:http assertion (start the server, hit it over the loopback) so the guard
// is proven to sit IN FRONT of the router — a bad secret 403s before any route
// (or Nextcloud) is reached.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { AddressInfo } from 'node:net'
import { checkGuard, isHealthzPath } from '../src/http/auth.ts'
import { createServer } from '../src/http/server.ts'

const SECRET = 'topsecret-shared-value'

function headers(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    'x-internal-auth': SECRET,
    'x-tenant-id': '11111111-1111-1111-1111-111111111111',
    'x-tenant-slug': 'alpha',
    ...over,
  }
}

// ── Unit: the guard (mirrors services/content guard.test.ts) ───────────────────

describe('isHealthzPath — guard exemption', () => {
  it('treats /healthz and /healthz/<sub> as exempt but not /healthzzz', () => {
    expect(isHealthzPath('/healthz')).toBe(true)
    expect(isHealthzPath('/healthz/ready')).toBe(true)
    expect(isHealthzPath('/api/v1/propfind')).toBe(false)
    expect(isHealthzPath('/healthzzz')).toBe(false)
  })
})

describe('checkGuard — shared secret (timingSafeEqual)', () => {
  it('rejects a missing x-internal-auth with 403', () => {
    const r = checkGuard({ path: '/api/v1/propfind', headers: headers({ 'x-internal-auth': undefined }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })
  it('rejects a wrong x-internal-auth with 403', () => {
    const r = checkGuard({ path: '/api/v1/propfind', headers: headers({ 'x-internal-auth': 'wrong' }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })
  it('rejects when the server secret itself is unset (fail-closed) with 403', () => {
    const r = checkGuard({ path: '/api/v1/propfind', headers: headers(), secret: undefined })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })
  it('accepts the correct secret (and a valid tenant)', () => {
    const r = checkGuard({ path: '/api/v1/propfind', headers: headers(), secret: SECRET })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.tenant).toEqual({ id: '11111111-1111-1111-1111-111111111111', slug: 'alpha' })
  })
})

describe('checkGuard — tenant headers', () => {
  it('rejects a missing x-tenant-id with 400', () => {
    const r = checkGuard({ path: '/x', headers: headers({ 'x-tenant-id': undefined }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(400)
  })
  it('rejects a missing x-tenant-slug with 400', () => {
    expect(checkGuard({ path: '/x', headers: headers({ 'x-tenant-slug': undefined }), secret: SECRET }).ok).toBe(false)
  })
  it('rejects an invalid slug grammar (uppercase / underscore) with 400', () => {
    expect(checkGuard({ path: '/x', headers: headers({ 'x-tenant-slug': 'Alpha' }), secret: SECRET }).ok).toBe(false)
    expect(checkGuard({ path: '/x', headers: headers({ 'x-tenant-slug': 'a_b' }), secret: SECRET }).ok).toBe(false)
  })
})

describe('checkGuard — evaluation order (no header oracle)', () => {
  it('checks the secret BEFORE tenant headers', () => {
    const r = checkGuard({ path: '/api/v1/propfind', headers: { 'x-internal-auth': 'wrong' }, secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })
})

// ── End-to-end: the node:http server enforces the guard in front of the router ──

describe('files leaf HTTP server — ACL sits in front of the router', () => {
  let server: ReturnType<typeof createServer>
  let base: string

  beforeAll(async () => {
    server = createServer({ secret: SECRET })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    base = `http://127.0.0.1:${port}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('GET /healthz → 200 {status:ok} without any auth', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('POST /api/v1/propfind without x-internal-auth → 403 (before the router/Nextcloud)', async () => {
    const res = await fetch(`${base}/api/v1/propfind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': 't', 'x-tenant-slug': 'alpha' },
      body: JSON.stringify({ path: '/p', user: 'u' }),
    })
    expect(res.status).toBe(403)
  })

  it('POST /api/v1/propfind with a WRONG secret → 403', async () => {
    const res = await fetch(`${base}/api/v1/propfind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-auth': 'wrong', 'x-tenant-id': 't', 'x-tenant-slug': 'alpha' },
      body: JSON.stringify({ path: '/p', user: 'u' }),
    })
    expect(res.status).toBe(403)
  })

  it('POST /api/v1/propfind with a valid secret but MISSING x-tenant-id → 400', async () => {
    const res = await fetch(`${base}/api/v1/propfind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-auth': SECRET, 'x-tenant-slug': 'alpha' },
      body: JSON.stringify({ path: '/p', user: 'u' }),
    })
    expect(res.status).toBe(400)
  })

  it('a fully-authorized request to an UNKNOWN path → 404 (guard passed, router not-found)', async () => {
    const res = await fetch(`${base}/api/v1/does-not-exist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers() } as Record<string, string>,
      body: '{}',
    })
    expect(res.status).toBe(404)
  })
})
