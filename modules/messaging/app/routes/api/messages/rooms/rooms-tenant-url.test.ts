// Design v11 review (same defect class as messages/register.server.ts
// unread-rooms): the per-room m.room.name state read must target the CURRENT
// tenant's homeserver — the per-user matrixToken is valid only there. A
// serviceEnv('MATRIX_URL')-only base would transmit a non-default tenant's
// token to the DEFAULT tenant's Synapse (cross-tenant credential disclosure).
// The tenant CONTEXT module is deliberately REAL and the request runs inside an
// explicit runWithTenant scope (matrix-synapse.tenant.test.ts pattern).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Role } from '$lib/auth/types'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'

const { mockGetMatrixToken, mockGetJoinedRooms, mockUnread } = vi.hoisted(() => ({
  mockGetMatrixToken: vi.fn(),
  mockGetJoinedRooms: vi.fn(),
  mockUnread: vi.fn(),
}))

vi.mock('$lib/server/messages/matrix-client', () => ({
  getMatrixClient: () => ({
    getMatrixToken: mockGetMatrixToken,
    getJoinedRooms: mockGetJoinedRooms,
    unreadMessageCountsByRoom: mockUnread,
    sync: vi.fn(),
  }),
}))

vi.mock('$lib/server/messages/synapse-admin', () => ({
  getSynapseAdmin: () => ({ forceJoinRoom: vi.fn().mockResolvedValue(undefined) }),
}))

// TASK-205b: the service endpoints (Matrix, Helios, LiveKit, Nextcloud) come through the serviceEnv seam, the
// successor of the deleted default-tenant env reader. This suite feeds the seam the same values it already
// feeds its `$env/dynamic/private` mock, so every case keeps its own env fixture.
vi.mock('$lib/server/env/service-env', async () => {
  const { env } = await import('$env/dynamic/private')
  return { serviceEnv: (name: string) => (env as Record<string, string | undefined>)[name] }
})
vi.mock('$env/dynamic/private', () => ({
  env: { MATRIX_URL: 'http://default-env:8008' },
}))

const ALPHA_CTX = {
  id: 'tid-alpha',
  slug: 'alpha',
  services: { matrixUrl: 'http://matrix-alpha:8008' },
} as unknown as TenantContext

let GET: (event: unknown) => Promise<Response>
let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(async () => {
  mockGetMatrixToken.mockReset().mockResolvedValue('matrix-token-alpha')
  mockGetJoinedRooms.mockReset().mockResolvedValue(['!room1:alpha.example.org'])
  mockUnread.mockReset().mockResolvedValue(new Map())
  fetchSpy = vi.fn(
    async () =>
      new Response(JSON.stringify({ name: 'Alpha Raum' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )
  vi.stubGlobal('fetch', fetchSpy)
  GET = (await import('./+server')).GET as (event: unknown) => Promise<Response>
})

afterEach(() => vi.unstubAllGlobals())

function event() {
  const user = {
    id: 'u',
    roles: [Role.Member],
    groups: [],
    email: 'u@example.org',
    name: 'u',
    preferredUsername: 'u',
  }
  return {
    locals: {
      user,
      accessToken: 'kc-jwt',
      auth: async () => ({ user, accessToken: 'kc-jwt', expires: '2099-01-01T00:00:00.000Z' }),
    },
    params: {},
    request: new Request('http://localhost/api/messages/rooms', {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
    }),
    url: new URL('http://localhost/api/messages/rooms'),
    fetch: async () => new Response('{}', { status: 200 }),
  }
}

describe('GET /api/messages/rooms — tenant-scoped homeserver base (design v11 review)', () => {
  it("reads m.room.name from the TENANT's homeserver, never the default env MATRIX_URL", async () => {
    const res = await runWithTenant(ALPHA_CTX, () => GET(event()))
    expect(res.status, await res.clone().text()).toBe(200)
    const body = await res.json()
    expect(body.data[0].name).toBe('Alpha Raum')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://matrix-alpha:8008/_matrix/client/v3/rooms/' +
        encodeURIComponent('!room1:alpha.example.org') +
        '/state/m.room.name',
    )
    expect(url).not.toContain('default-env')
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer matrix-token-alpha',
    )
  })

  it('falls back to env MATRIX_URL for the default tenant (byte-identical)', async () => {
    const DEFAULT_CTX = { id: 'tid-default', slug: 'default' } as unknown as TenantContext
    const res = await runWithTenant(DEFAULT_CTX, () => GET(event()))
    expect(res.status).toBe(200)
    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toContain('http://default-env:8008/_matrix/client/v3/rooms/')
  })
})
