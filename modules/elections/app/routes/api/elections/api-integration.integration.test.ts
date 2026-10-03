// G-100 — elections api integration tests with explicit dual-auth-flow coverage.
//
// Filename note: see api-integration.integration.test.ts in the finance
// directory for the rationale behind the double-".integration" suffix.
//
// The elections root handler (`GET /api/elections`) reads `locals.auth()`
// directly (still on the pre-G-006 pattern — the role gate uses
// `session?.user` instead of `locals.user`). For Bearer JWT clients,
// `hooks.server.ts:179-181` overrides `event.locals.auth` to return a
// synthetic session shape, so both auth flows produce the same `await
// locals.auth()` result. The test exercises both paths anyway as a
// regression net against a future refactor that breaks that override.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth/types'

// Mock all elections-side collaborators so the role-gated path can reach
// the handler body without spinning up Helios/Keycloak/DB.
const { mockFindAll, mockFindVisibleToUser, mockGetElection } = vi.hoisted(() => ({
  mockFindAll: vi.fn(),
  mockFindVisibleToUser: vi.fn(),
  mockGetElection: vi.fn(),
}))

vi.mock('$lib/server/elections/election-db', () => ({
  ElectionDb: {
    findAll: mockFindAll,
    findVisibleToUser: mockFindVisibleToUser,
    insert: vi.fn(),
    markCalendarLinked: vi.fn(),
  },
}))

vi.mock('$lib/server/elections/helios-client', () => ({
  HeliosClient: {
    getElection: mockGetElection,
    createElection: vi.fn(),
    setQuestions: vi.fn(),
    bulkUploadVoters: vi.fn(),
    freeze: vi.fn(),
  },
  HeliosAppError: class HeliosAppError extends Error {},
  deriveLifecycle: vi.fn().mockReturnValue('open'),
}))

vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClient: () => ({ getUser: vi.fn() }),
}))

vi.mock('$lib/server/governance/org-units-db', () => ({
  listOrgUnitMembers: vi.fn().mockResolvedValue([]),
}))

vi.mock('$env/dynamic/private', () => ({
  env: new Proxy({}, { get: () => 'sentinel' }),
}))

/** Cribbed from src/lib/auth/decode.test.ts:14-18. See finance test for full note. */
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64url')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.signature-not-verified`
}

interface AuthSpec {
  cookie?: { roles: Role[] }
  bearer?: { roles: Role[]; jwt: string }
}

function makeEvent(opts: { method: 'GET' | 'POST'; auth: AuthSpec; body?: unknown }) {
  const { method, auth, body } = opts
  const user = auth.cookie
    ? { id: 'u-cookie', roles: auth.cookie.roles, groups: [] }
    : auth.bearer
      ? { id: 'u-bearer', roles: auth.bearer.roles, groups: [] }
      : null
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (auth.bearer) headers.Authorization = `Bearer ${auth.bearer.jwt}`

  return {
    locals: {
      user,
      accessToken: auth.bearer?.jwt ?? null,
      // Elections route reads `await locals.auth()` for the session; mirror
      // what hooks.server.ts does for both flows — Bearer override at :180,
      // Auth.js session at :188.
      auth: async () => (user ? { user, expires: '2099-01-01T00:00:00.000Z' } : null),
    },
    params: {},
    request: new Request('http://localhost/api/elections', {
      method,
      headers,
      body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
    }),
    url: new URL('http://localhost/api/elections'),
    fetch: async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  }
}

let GET: (event: unknown) => Promise<Response>

beforeEach(async () => {
  mockFindAll.mockReset().mockResolvedValue([])
  mockFindVisibleToUser.mockReset().mockResolvedValue([])
  mockGetElection.mockReset()
  const mod = await import('./+server')
  GET = mod.GET as (event: unknown) => Promise<Response>
})

describe('G-100 elections api — dual auth flow', () => {
  describe('GET /api/elections', () => {
    it('lets a Member user through via session cookie (returns 200 with data array)', async () => {
      const event = makeEvent({ method: 'GET', auth: { cookie: { roles: [Role.Member] } } })
      const res = await GET(event)
      expect(res.status, await res.clone().text()).toBe(200)
      const body = await res.json() as { success: boolean; data: unknown[] }
      expect(body.success).toBe(true)
      expect(Array.isArray(body.data)).toBe(true)
    })

    it('lets a Member user through via Authorization: Bearer JWT', async () => {
      const jwt = makeJwt({ sub: 'bearer-user', preferred_username: 'mobile' })
      const event = makeEvent({ method: 'GET', auth: { bearer: { roles: [Role.Member], jwt } } })
      const res = await GET(event)
      expect(res.status, await res.clone().text()).toBe(200)
    })

    it('returns 403 for anonymous (no session cookie, no Authorization header)', async () => {
      // Elections root returns 403 not 401 for anonymous because the
      // gate uses `!hasRole(user.roles, Role.Member)` — for `user`
      // undefined the short-circuit `!user || ...` triggers, and the
      // response is the 403 "Forbidden" branch shared with non-member.
      const event = makeEvent({ method: 'GET', auth: {} })
      const res = await GET(event)
      expect(res.status).toBe(403)
    })

    it('returns 403 for a signed-in non-Member user', async () => {
      const event = makeEvent({ method: 'GET', auth: { cookie: { roles: [Role.Guest] } } })
      const res = await GET(event)
      expect(res.status).toBe(403)
    })

    it('rejects the request when both auth flows are stripped post-handshake', async () => {
      // Same contrived regression as the finance suite. Elections returns
      // 403 rather than 401 here, but the contract — "no auth → no data" —
      // is what matters for G-100.
      const event = makeEvent({ method: 'GET', auth: {} })
      const res = await GET(event)
      expect([401, 403]).toContain(res.status)
      const body = await res.json() as { success: boolean }
      expect(body.success).toBe(false)
    })
  })
})
