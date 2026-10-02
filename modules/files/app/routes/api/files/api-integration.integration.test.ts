// G-100 — files api integration tests with explicit dual-auth-flow coverage.
//
// Filename note: see api-integration.integration.test.ts in the finance
// directory for the rationale behind the double-".integration" suffix.
//
// The files root handler (`GET /api/files/[...path]`) reads `locals.user`
// directly via the local `requireAuth(event)` helper and proxies the
// request to a Nextcloud client constructed from env vars. Both auth flows
// produce `locals.user`, so the route's gate is symmetric — the Bearer
// path additionally carries an Authorization header on the synthetic
// request, which the route itself ignores but which documents the flow.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth/types'

const { mockPropfind, mockDownload } = vi.hoisted(() => ({
  mockPropfind: vi.fn(),
  mockDownload: vi.fn(),
}))

vi.mock('$lib/server/files/nextcloud-client', () => ({
  createNextcloudClient: () => ({
    propfind: mockPropfind,
    download: mockDownload,
    upload: vi.fn(),
    delete: vi.fn(),
    move: vi.fn(),
    copy: vi.fn(),
    mkcol: vi.fn(),
  }),
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

function makeEvent(opts: { method: 'GET' | 'DELETE'; auth: AuthSpec; path?: string }) {
  const { method, auth, path } = opts
  const user = auth.cookie
    ? { id: 'u-cookie', roles: auth.cookie.roles, groups: [], email: 'u@example.org', name: 'u', preferredUsername: 'testuser' }
    : auth.bearer
      ? { id: 'u-bearer', roles: auth.bearer.roles, groups: [], email: 'u@example.org', name: 'u', preferredUsername: 'testuser' }
      : null
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (auth.bearer) headers.Authorization = `Bearer ${auth.bearer.jwt}`

  const paramPath = path ?? ''
  return {
    locals: {
      user,
      accessToken: auth.bearer?.jwt ?? null,
      auth: async () => (user ? { user, expires: '2099-01-01T00:00:00.000Z' } : null),
    },
    params: { path: paramPath },
    request: new Request(`http://localhost/api/files/${paramPath}`, { method, headers }),
    url: new URL(`http://localhost/api/files/${paramPath}`),
    fetch: async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  }
}

let GET: (event: unknown) => Promise<Response>

beforeEach(async () => {
  mockPropfind.mockReset().mockResolvedValue([])
  mockDownload.mockReset()
  const mod = await import('./[...path]/+server')
  GET = mod.GET as (event: unknown) => Promise<Response>
})

describe('G-100 files api — dual auth flow', () => {
  describe('GET /api/files/[...path] (directory listing)', () => {
    it('lets an authenticated user through via session cookie (returns 200 with files array)', async () => {
      const event = makeEvent({ method: 'GET', auth: { cookie: { roles: [Role.Member] } } })
      const res = await GET(event)
      expect(res.status, await res.clone().text()).toBe(200)
      const body = await res.json() as { success: boolean; files: unknown[] }
      expect(body.success).toBe(true)
      expect(Array.isArray(body.files)).toBe(true)
    })

    it('lets an authenticated user through via Authorization: Bearer JWT', async () => {
      const jwt = makeJwt({ sub: 'bearer-user', preferred_username: 'testuser' })
      const event = makeEvent({ method: 'GET', auth: { bearer: { roles: [Role.Member], jwt } } })
      const res = await GET(event)
      expect(res.status, await res.clone().text()).toBe(200)
    })

    it('returns 401 for anonymous (no session cookie, no Authorization header)', async () => {
      const event = makeEvent({ method: 'GET', auth: {} })
      try {
        const res = await GET(event)
        expect(res.status).toBe(401)
      } catch (err) {
        // SvelteKit's `error(401, 'Unauthenticated')` throws an HttpError
        // object rather than returning a Response — assert the status on
        // the thrown shape instead. Either contract satisfies "no anon".
        expect((err as { status?: number }).status).toBe(401)
      }
    })

    it('returns 401 when both auth flows are stripped post-handshake', async () => {
      const event = makeEvent({ method: 'GET', auth: {} })
      try {
        const res = await GET(event)
        expect(res.status).toBe(401)
      } catch (err) {
        expect((err as { status?: number }).status).toBe(401)
      }
    })

    it('returns a clean typed 403 for a Guest-only user (no Nextcloud account, #194)', async () => {
      // #194: guests are never provisioned a Nextcloud account, so a WebDAV call
      // on their bearer always 404s → 502 → "<!DOCTYPE … is not valid JSON" in the
      // browser. The GET handler now short-circuits a guest-only user with a clean
      // typed JSON 403 (reason: 'no_document_access') BEFORE touching Nextcloud, so
      // a direct API hit / stale client renders a "kein Dokumentenzugriff" state
      // rather than a raw parse error. (The page + nav entry are also member-gated.)
      const event = makeEvent({ method: 'GET', auth: { cookie: { roles: [Role.Guest] } } })
      const res = await GET(event)
      expect(res.status, await res.clone().text()).toBe(403)
      const body = await res.json() as { success: boolean; reason: string }
      expect(body.success).toBe(false)
      expect(body.reason).toBe('no_document_access')
    })
  })
})
