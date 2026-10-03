// service-mode-g022.test.ts — #368 Finding 3: G-022 SERVICE-mode route tests.
//
// The existing token.test.ts / meeting-room.test.ts exercise the routes flag-OFF
// (inprocess). These pin the SERVICE path: with MESSAGES_BACKEND=service the kernel
// video/token + meeting-room routes drive the ServiceMessagesClient over HTTP to the
// messages leaf. We mock the leaf HTTP endpoint (globalThis.fetch, dispatched by
// path) and assert, END-TO-END through the internal ACL hop:
//   (b) the empty-string SOFT-FAIL survives the leaf hop — a leaf error OR leaf-
//       returned empty strings map to empty creds WITHOUT throwing. Since #257-1 the
//       video/token ROOM branch is membership-gated and FAILS CLOSED on an unresolved
//       matrixUserId, so an empty-cred soft-fail now 403s (before minting) — matching
//       meeting-room, which also 403s. A clean 403 (not 500) is itself proof the
//       client soft-failed rather than threw; and
//   (c) in service mode the KERNEL route sets the HttpOnly matrix_access cookie from
//       resolveMatrixCreds' accessToken (the leaf-returned Matrix token) and the JSON
//       body carries ONLY the LiveKit token — never a Matrix token (G-022). The room
//       call is admitted by the video.meeting-room { isMember: true } leaf response
//       (the #257-1 membership gate's service-path forward).
//
// Mirrors the service-client.test.ts mocking style (getTenant + getKeycloakJwt +
// livekit-client mocked; leaf reached via globalThis.fetch).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock the kernel Matrix/LiveKit/Synapse/creds modules so importing the backend
// index (which statically pulls the inprocess client) does not drag the real
// per-tenant client graph in. Only the SERVICE path is exercised here — its
// livekit() reuses the (pure) roomName helpers below; mintToken goes to the leaf.
vi.mock('$lib/server/messages/matrix-client', () => ({
  getMatrixClient: vi.fn(),
  evictMatrixClient: vi.fn(),
}))
vi.mock('$lib/server/messages/synapse-admin', () => ({
  getSynapseAdmin: vi.fn(),
  evictSynapseAdmin: vi.fn(),
}))
vi.mock('$lib/server/messages/livekit-client', () => ({
  mintToken: vi.fn(),
  roomNameFromMatrixId: (id: string) => `stura-room-${id.replace(/^!/, '').split(':')[0]}`,
  dmRoomName: () => 'stura-dm-abcdef1234567890',
  evictLivekitSettings: vi.fn(),
}))
vi.mock('$lib/server/messages/matrix-creds', () => ({
  getKeycloakJwt: vi.fn(async () => 'kc-jwt'),
  resolveMatrixCreds: vi.fn(),
}))
vi.mock('$lib/server/tenant/context', () => ({
  getTenant: () => ({ id: 'tenant-1', slug: 'default' }),
}))

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// Per-test-configurable leaf responses.
let matrixTokenLeaf: () => Response
let videoTokenLeaf: () => Response
// #257-1: the video/token room branch gates on membership via the video.meeting-room
// { isMember } multiplex (ServiceMessagesClient.synapse().isRoomMember → this path).
let meetingRoomLeaf: () => Response

const makeLocals = (role: string) => ({
  auth: async () => ({
    user: { name: 'Test User', email: 'test@example.com', roles: [role], groups: [], id: 'sub-1', preferredUsername: 'u' },
    accessToken: 'kc_jwt',
  }),
  user: undefined,
})

const makeCookies = () => ({
  set: vi.fn(),
  get: vi.fn(),
  getAll: vi.fn().mockReturnValue([]),
  delete: vi.fn(),
  serialize: vi.fn(),
})

const makeRequest = (path: string, body: Record<string, unknown>) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.resetModules()
  process.env.MESSAGES_BACKEND = 'service'
  process.env.MESSAGES_SERVICE_URL = 'http://messages-service:8080'
  process.env.INTERNAL_MESSAGES_SECRET = 's3cr3t'
  matrixTokenLeaf = () => jsonRes({ matrixToken: 'mx_leaf_token', matrixUserId: '@u:s' })
  videoTokenLeaf = () => jsonRes({ token: 'lk_leaf_token' })
  meetingRoomLeaf = () => jsonRes({ isMember: true })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      const path = new URL(href).pathname
      if (path === '/api/v1/auth/matrix-token') return matrixTokenLeaf()
      if (path === '/api/v1/video/token') return videoTokenLeaf()
      if (path === '/api/v1/video/meeting-room') return meetingRoomLeaf()
      throw new Error(`unexpected leaf call in test: ${path}`)
    }),
  )
})

afterEach(() => {
  delete process.env.MESSAGES_BACKEND
  delete process.env.MESSAGES_SERVICE_URL
  delete process.env.INTERNAL_MESSAGES_SECRET
  vi.unstubAllGlobals()
})

describe('POST /api/video/token — MESSAGES_BACKEND=service (G-022)', () => {
  it('backend is the service client (flag routes to the leaf)', async () => {
    const { getMessagesBackend } = await import('$lib/server/messages/backend')
    expect(getMessagesBackend().kind).toBe('service')
  })

  // (c) — the KERNEL route sets the cookie from the leaf token; body has only LiveKit.
  it('sets the matrix_access cookie from the LEAF-returned Matrix token; body carries ONLY the LiveKit token', async () => {
    const { POST } = await import('./token/+server')
    const cookies = makeCookies()
    const res = await POST({
      request: makeRequest('/api/video/token', { roomType: 'room', matrixRoomId: '!abc123:matrix.test' }),
      locals: makeLocals('member'),
      cookies,
    } as unknown as Parameters<typeof POST>[0])

    expect(res.status).toBe(200)
    const body = await res.json()
    // Body carries the LiveKit token (from the leaf video.token op) + the user id.
    expect(body.token).toBe('lk_leaf_token')
    expect(body.matrixUserId).toBe('@u:s')
    // G-022: the raw MATRIX token must NEVER appear in the browser-facing body...
    expect(JSON.stringify(body)).not.toContain('mx_leaf_token')
    // ...it is scoped to the HttpOnly /matrix cookie instead.
    expect(cookies.set).toHaveBeenCalledWith(
      'matrix_access',
      'mx_leaf_token',
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'strict', path: '/matrix', maxAge: 3600 }),
    )
  })

  // (b) + #257-1 gate — a leaf FAILURE on the creds op soft-fails to EMPTY creds (the
  // client never throws). For a ROOM call the fail-closed membership gate then rejects
  // the unresolved matrixUserId with 403 BEFORE minting or setting a cookie — a soft-
  // fail that now degrades CLOSED (403), not to an anonymous token. A throw would
  // surface as 500, so the clean 403 also proves resolveMatrixCreds soft-failed.
  it('a leaf matrix-token FAILURE soft-fails to empty creds → room gate rejects 403, no token minted, no cookie', async () => {
    matrixTokenLeaf = () => new Response('upstream boom', { status: 502 })
    const { POST } = await import('./token/+server')
    const cookies = makeCookies()
    const res = await POST({
      request: makeRequest('/api/video/token', { roomType: 'room', matrixRoomId: '!abc123:matrix.test' }),
      locals: makeLocals('member'),
      cookies,
    } as unknown as Parameters<typeof POST>[0])

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(cookies.set).not.toHaveBeenCalled()
  })

  // (b) + #257-1 gate — leaf returns EMPTY STRINGS (not an error): still soft-fails,
  // never throws. For a ROOM call the empty matrixUserId again fails the membership
  // gate CLOSED (403) before any leaf video.token / meeting-room call is made.
  it('leaf-returned EMPTY creds also soft-fail (client never throws) → room gate rejects 403, no cookie', async () => {
    matrixTokenLeaf = () => jsonRes({ matrixToken: '', matrixUserId: '' })
    const { POST } = await import('./token/+server')
    const cookies = makeCookies()
    const res = await POST({
      request: makeRequest('/api/video/token', { roomType: 'room', matrixRoomId: '!abc123:matrix.test' }),
      locals: makeLocals('member'),
      cookies,
    } as unknown as Parameters<typeof POST>[0])

    expect(res.status).toBe(403)
    expect((await res.json()).success).toBe(false)
    expect(cookies.set).not.toHaveBeenCalled()
  })
})

describe('POST /api/video/meeting-room — MESSAGES_BACKEND=service (G-022 soft-fail)', () => {
  // (b) — meeting-room REQUIRES creds: leaf empty strings survive the ACL hop → 403.
  it('leaf empty-string creds survive the ACL hop → 403 (client never throws, no matrix ops attempted)', async () => {
    matrixTokenLeaf = () => jsonRes({ matrixToken: '', matrixUserId: '' })
    const { POST } = await import('./meeting-room/+server')
    const res = await POST({
      request: makeRequest('/api/video/meeting-room', { eventId: 'EVT-1' }),
      locals: makeLocals('member'),
      url: new URL('http://localhost/api/video/meeting-room'),
    } as unknown as Parameters<typeof POST>[0])
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'No Matrix credentials for user' })
  })

  it('a leaf matrix-token FAILURE also 403s meeting-room (soft-fail → empty creds → reject)', async () => {
    matrixTokenLeaf = () => new Response('upstream boom', { status: 502 })
    const { POST } = await import('./meeting-room/+server')
    const res = await POST({
      request: makeRequest('/api/video/meeting-room', { eventId: 'EVT-1' }),
      locals: makeLocals('member'),
      url: new URL('http://localhost/api/video/meeting-room'),
    } as unknown as Parameters<typeof POST>[0])
    expect(res.status).toBe(403)
  })
})
