// G-100 — messages api integration tests with explicit dual-auth-flow coverage.
//
// Filename note: see api-integration.integration.test.ts in the finance
// directory for the rationale behind the double-".integration" suffix.
//
// The messages root handler (`GET /api/messages/rooms`) is the most
// interesting route group from a dual-flow perspective: its local
// `getKeycloakJwt(event)` helper EXPLICITLY reads the Authorization
// header first (returning the Bearer token verbatim) and only falls back
// to `await event.locals.auth()` when no header is present. This means
// the route's behaviour visibly diverges based on which auth flow the
// caller used — making it the right surface for the gap-list's
// "Bearer/Cookie regression test" requirement.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth/types'

const { mockGetMatrixToken, mockGetJoinedRooms } = vi.hoisted(() => ({
  mockGetMatrixToken: vi.fn(),
  mockGetJoinedRooms: vi.fn(),
}))

vi.mock('$lib/server/messages/matrix-client', () => ({
  getMatrixClient: () => ({
    getMatrixToken: mockGetMatrixToken,
    getJoinedRooms: mockGetJoinedRooms,
    unreadMessageCountsByRoom: vi.fn().mockResolvedValue(new Map()),
    sync: vi.fn(),
  }),
}))

vi.mock('$lib/server/messages/synapse-admin', () => ({
  getSynapseAdmin: () => ({
    forceJoinRoom: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('$env/dynamic/private', () => ({
  env: new Proxy({}, { get: () => 'sentinel' }),
}))

// Some code paths in messages/rooms call global fetch directly (whoami,
// state polling). Provide a benign stub so the role-gated path doesn't
// blow up on the outbound HTTP call.
vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ rooms: [] }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
}))

/** Cribbed from src/lib/auth/decode.test.ts:14-18. See finance test for full note. */
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64url')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.signature-not-verified`
}

interface AuthSpec {
  /** Session-cookie path: locals.user set + session.accessToken returned by locals.auth(). */
  cookie?: { roles: Role[]; accessToken?: string }
  /** Bearer path: locals.user set + Authorization header carrying the JWT. */
  bearer?: { roles: Role[]; jwt: string }
}

function makeEvent(opts: { method: 'GET'; auth: AuthSpec }) {
  const { method, auth } = opts
  const user = auth.cookie
    ? { id: 'u-cookie', roles: auth.cookie.roles, groups: [], email: 'u@example.org', name: 'u', preferredUsername: 'u' }
    : auth.bearer
      ? { id: 'u-bearer', roles: auth.bearer.roles, groups: [], email: 'u@example.org', name: 'u', preferredUsername: 'u' }
      : null
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (auth.bearer) headers.Authorization = `Bearer ${auth.bearer.jwt}`

  return {
    locals: {
      user,
      // accessToken on locals isn't read by messages/rooms — the route
      // pulls the token via `event.locals.auth()` for cookie clients
      // (matching hooks.server.ts:201's session.accessToken pickup).
      accessToken: auth.bearer?.jwt ?? null,
      auth: async () =>
        user
          ? {
              user,
              accessToken: auth.cookie?.accessToken ?? auth.bearer?.jwt ?? null,
              expires: '2099-01-01T00:00:00.000Z',
            }
          : null,
    },
    params: {},
    request: new Request('http://localhost/api/messages/rooms', { method, headers }),
    url: new URL('http://localhost/api/messages/rooms'),
    fetch: async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  }
}

let GET: (event: unknown) => Promise<Response>

beforeEach(async () => {
  mockGetMatrixToken.mockReset().mockResolvedValue('matrix-token-abc')
  mockGetJoinedRooms.mockReset().mockResolvedValue(['!room1:matrix.example'])
  const mod = await import('./rooms/+server')
  GET = mod.GET as (event: unknown) => Promise<Response>
})

describe('G-100 messages api — dual auth flow', () => {
  describe('GET /api/messages/rooms (representative handler)', () => {
    it('lets an authenticated user through via session cookie + session.accessToken', async () => {
      const event = makeEvent({
        method: 'GET',
        auth: { cookie: { roles: [Role.Member], accessToken: 'kc-jwt-from-session' } },
      })
      const res = await GET(event)
      expect(res.status, await res.clone().text()).toBe(200)
      // The route asks the Matrix client to exchange the Keycloak JWT for
      // a Matrix token; under the cookie flow the JWT came from
      // session.accessToken.
      expect(mockGetMatrixToken).toHaveBeenCalledWith('kc-jwt-from-session')
    })

    it('lets an authenticated user through via Authorization: Bearer JWT', async () => {
      const jwt = makeJwt({ sub: 'bearer-user', preferred_username: 'mobile' })
      const event = makeEvent({
        method: 'GET',
        auth: { bearer: { roles: [Role.Member], jwt } },
      })
      const res = await GET(event)
      expect(res.status, await res.clone().text()).toBe(200)
      // Under the Bearer flow, getKeycloakJwt at +server.ts:14-21 returns
      // the raw header value — assert it forwarded the JWT verbatim.
      expect(mockGetMatrixToken).toHaveBeenCalledWith(jwt)
    })

    it('returns 401 for anonymous (no session cookie, no Authorization header)', async () => {
      const event = makeEvent({ method: 'GET', auth: {} })
      try {
        const res = await GET(event)
        expect(res.status).toBe(401)
      } catch (err) {
        expect((err as { status?: number }).status).toBe(401)
      }
    })

    it('returns 401 when both auth flows are stripped post-handshake', async () => {
      // Contrived regression for the cluster-6 acceptance gate: with
      // locals.user wiped AND no Authorization header, requireAuth at
      // +server.ts:8-12 must short-circuit to 401, NOT fall through into
      // a Matrix call.
      const event = makeEvent({ method: 'GET', auth: {} })
      try {
        const res = await GET(event)
        expect(res.status).toBe(401)
      } catch (err) {
        expect((err as { status?: number }).status).toBe(401)
      }
      // Matrix must NOT have been called in either of the two anon shapes.
      expect(mockGetMatrixToken).not.toHaveBeenCalled()
    })

    it('rejects when locals.user is set but no token can be sourced from either flow', async () => {
      // Edge case: hooks.server.ts could populate locals.user from a
      // session whose accessToken got dropped (e.g. corrupt session
      // store), AND no Authorization header on the request. The
      // getKeycloakJwt helper throws 401 "No Keycloak access token in
      // session", which the outer try/catch in messages/rooms/+server.ts
      // rewraps as `error(502, 'Matrix authentication failed: ...')` —
      // either status indicates "no auth happened, request rejected".
      // Asserting 401|502 documents the rewrap behaviour without forcing
      // a behaviour change that's out of scope for this cluster.
      const event = makeEvent({
        method: 'GET',
        auth: { cookie: { roles: [Role.Member] /* no accessToken */ } },
      })
      try {
        const res = await GET(event)
        expect([401, 502]).toContain(res.status)
      } catch (err) {
        expect([401, 502]).toContain((err as { status?: number }).status)
      }
    })
  })
})
