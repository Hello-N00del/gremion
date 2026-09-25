// services/messages/test/route-parity.test.ts
// Route-parity + ACL test for the messages+video leaf (mirrors the intent of the
// calendar/content/files backend route-parity tests, and the ACL shape of
// services/files/test/http-acl.test.ts).
//
// TWO guarantees are pinned here:
//   1. ROUTE PARITY — the leaf's OPERATIONS contract exposes exactly one internal
//      `/api/v1/*` endpoint for every messages+video API route the kernel serves
//      today (the extraction surface). If a kernel route were added/removed the
//      contract (and this list) must move in lockstep, so the extraction can
//      never silently drop a route.
//   2. ACL — the internal guard (constant-time x-internal-auth secret +
//      x-tenant-id/x-tenant-slug) sits IN FRONT of the router: a bad secret 403s
//      before any op is dispatched; /healthz is exempt.
//
// This is the RED test: it fails until src/operations.ts + src/http/auth.ts +
// src/http/server.ts exist.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { AddressInfo } from 'node:net'
import { OPERATIONS } from '../src/operations.ts'
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

// ── The extraction surface: every kernel messages+video API route (grep-verified
//    against src/routes/api/{messages,video,auth/matrix-*}). Each MUST map to one
//    leaf op. ────────────────────────────────────────────────────────────────────
const KERNEL_ROUTES: ReadonlyArray<{ method: string; route: string }> = [
  { method: 'GET', route: '/api/messages/sync' },
  { method: 'GET', route: '/api/messages/rooms' },
  { method: 'GET', route: '/api/messages/rooms/[roomId]/messages' },
  { method: 'POST', route: '/api/messages/rooms/[roomId]/messages' },
  { method: 'GET', route: '/api/messages/rooms/[roomId]/media' },
  { method: 'POST', route: '/api/messages/rooms/[roomId]/media' },
  { method: 'POST', route: '/api/messages/rooms/[roomId]/read' },
  { method: 'PUT', route: '/api/messages/rooms/[roomId]/typing' },
  { method: 'POST', route: '/api/video/token' },
  { method: 'POST', route: '/api/video/meeting-room' },
  { method: 'GET', route: '/api/video/openid-token' },
  { method: 'POST', route: '/api/video/matrix-widget-action' },
  { method: 'GET', route: '/api/auth/matrix-token' },
  { method: 'DELETE', route: '/api/auth/matrix-device' },
]

// ── Route parity ────────────────────────────────────────────────────────────────

describe('messages leaf OPERATIONS — route parity with the kernel surface', () => {
  it('exposes exactly one leaf op per kernel messages+video route (1:1, no drift)', () => {
    const kernelKey = (r: { method: string; route: string }) => `${r.method} ${r.route}`
    const expected = new Set(KERNEL_ROUTES.map(kernelKey))
    const actual = new Set(OPERATIONS.map((o) => `${o.kernelMethod} ${o.kernelRoute}`))
    expect(actual).toEqual(expected)
    // No two ops collapse onto the same kernel route.
    expect(OPERATIONS.length).toBe(KERNEL_ROUTES.length)
  })

  it('every leaf op has a unique internal /api/v1/* path served over POST', () => {
    const paths = OPERATIONS.map((o) => o.path)
    expect(new Set(paths).size).toBe(paths.length)
    for (const o of OPERATIONS) {
      expect(o.path.startsWith('/api/v1/')).toBe(true)
      expect(o.method).toBe('POST')
      expect(o.op.length).toBeGreaterThan(0)
    }
  })
})

// ── Unit: the guard (mirrors services/files test/http-acl.test.ts) ────────────────

describe('isHealthzPath — guard exemption', () => {
  it('treats /healthz and /healthz/<sub> as exempt but not /healthzzz', () => {
    expect(isHealthzPath('/healthz')).toBe(true)
    expect(isHealthzPath('/healthz/ready')).toBe(true)
    expect(isHealthzPath('/api/v1/messages/sync')).toBe(false)
    expect(isHealthzPath('/healthzzz')).toBe(false)
  })
})

describe('checkGuard — shared secret (timingSafeEqual)', () => {
  it('rejects a missing x-internal-auth with 403', () => {
    const r = checkGuard({ path: '/api/v1/messages/sync', headers: headers({ 'x-internal-auth': undefined }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })
  it('rejects a wrong x-internal-auth with 403', () => {
    const r = checkGuard({ path: '/api/v1/messages/sync', headers: headers({ 'x-internal-auth': 'wrong' }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })
  it('rejects when the server secret itself is unset (fail-closed) with 403', () => {
    const r = checkGuard({ path: '/api/v1/messages/sync', headers: headers(), secret: undefined })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })
  it('accepts the correct secret (and a valid tenant)', () => {
    const r = checkGuard({ path: '/api/v1/messages/sync', headers: headers(), secret: SECRET })
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
    const r = checkGuard({ path: '/api/v1/messages/sync', headers: { 'x-internal-auth': 'wrong' }, secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })
})

// ── End-to-end: the node:http server enforces the guard in front of the router ────

describe('messages leaf HTTP server — ACL sits in front of the router', () => {
  let server: ReturnType<typeof createServer>
  let base: string

  // Inject a fake forwarding backend so the authorized-op case (messages.sync)
  // forwards to it instead of a live Synapse. The guard/404/405 cases never reach
  // dispatch, so only matrix.sync is exercised here.
  const FORWARDED_SYNC = { nextBatch: 'nb-parity', rooms: [] as unknown[] }
  const fakeDeps = {
    matrix: { sync: async () => FORWARDED_SYNC },
    synapse: {},
    livekit: { apiKey: 'k', apiSecret: 's' },
  } as unknown as Parameters<typeof createServer>[0]['deps']

  beforeAll(async () => {
    server = createServer({ secret: SECRET, deps: fakeDeps })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    base = `http://127.0.0.1:${port}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const sampleOp = () => OPERATIONS[0]!

  it('GET /healthz → 200 {status:ok} without any auth', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('POST a known op without x-internal-auth → 403 (before the router)', async () => {
    const res = await fetch(`${base}${sampleOp().path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': 't', 'x-tenant-slug': 'alpha' },
      body: '{}',
    })
    expect(res.status).toBe(403)
  })

  it('POST a known op with a WRONG secret → 403', async () => {
    const res = await fetch(`${base}${sampleOp().path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-auth': 'wrong', 'x-tenant-id': 't', 'x-tenant-slug': 'alpha' },
      body: '{}',
    })
    expect(res.status).toBe(403)
  })

  it('POST a known op with a valid secret but MISSING x-tenant-id → 400', async () => {
    const res = await fetch(`${base}${sampleOp().path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-auth': SECRET, 'x-tenant-slug': 'alpha' },
      body: '{}',
    })
    expect(res.status).toBe(400)
  })

  it('a fully-authorized request to a KNOWN op → forwarded 200 (guard passed, router matched, op forwarded to the mocked upstream)', async () => {
    // The forwarding is now wired: a matched, guarded op forwards to
    // Matrix/LiveKit/Synapse and relays the result. messages.sync forwards to the
    // injected fake backend (no live Synapse) and returns its normalized
    // SyncResponse — proving the guard fronts a matched route AND the forward runs
    // (NOT 403, NOT 404, NOT 501).
    const res = await fetch(`${base}${sampleOp().path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers() } as Record<string, string>,
      body: JSON.stringify({ userToken: 'tok' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(FORWARDED_SYNC)
  })

  it('a fully-authorized request to an UNKNOWN path → 404 (guard passed, router not-found)', async () => {
    const res = await fetch(`${base}/api/v1/does-not-exist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers() } as Record<string, string>,
      body: '{}',
    })
    expect(res.status).toBe(404)
  })

  it('a known op over a non-POST method → 405', async () => {
    const res = await fetch(`${base}${sampleOp().path}`, {
      method: 'GET',
      headers: { ...headers() } as Record<string, string>,
    })
    expect(res.status).toBe(405)
  })
})
