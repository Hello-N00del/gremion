import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'

// P2.1b T7 — per-tenant rebind of getMatrixClient/getSynapseAdmin.
// The tenant CONTEXT module is deliberately REAL and every per-tenant case
// uses an EXPLICIT runWithTenant(ctx, …) scope
// ([[als-default-tenant-test-harness-masks-fail-closed]], plan standing rule 5).

vi.mock('$env/dynamic/private', () => ({
  env: {
    MATRIX_URL: 'http://matrix.test:8008',
    SYNAPSE_ADMIN_TOKEN: 'env-admin-token',
    SYNAPSE_ADMIN_BOT_USER_ID: '@bot:matrix.test',
    SYNAPSE_SERVER_NAME: 'matrix.test',
    ALPHA_SYNAPSE_TOKEN: 'alpha-admin-token',
  },
}))

import {
  getMatrixClient,
  evictMatrixClient,
  __resetMatrixCachesForTests,
} from './matrix-client'
import {
  getSynapseAdmin,
  evictSynapseAdmin,
  __resetSynapseAdminForTests,
} from './synapse-admin'

const DEFAULT_CTX = {
  id: 'tid-default',
  slug: 'default',
  // Byte-identical pin: even if a registry row ever carries service overrides,
  // the DEFAULT tenant's clients must keep building from env exactly as today.
  services: { matrixUrl: 'http://never-used:1', synapseServerName: 'never.used' },
} as unknown as TenantContext

const ALPHA_CTX = {
  id: 'tid-alpha',
  slug: 'alpha',
  services: {
    matrixUrl: 'http://matrix-alpha:8008',
    synapseAdminTokenRef: 'env:ALPHA_SYNAPSE_TOKEN',
    synapseAdminBotUserId: '@bot:alpha.example.org',
    synapseServerName: 'alpha.example.org',
  },
} as unknown as TenantContext

// No services at all — a non-default tenant falls back to env (shared stack
// until P2.1c provisioning writes real per-tenant endpoints).
const BETA_CTX = { id: 'tid-beta', slug: 'beta' } as unknown as TenantContext

function jwtWithSub(sub: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url')
  return `h.${payload}.s`
}

describe('getMatrixClient — per-tenant keyed registry (T7)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    __resetMatrixCachesForTests()
    let n = 0
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ room_id: '!r:x', access_token: `mx-${++n}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('fail-closed: throws outside any tenant scope', () => {
    expect(() => getMatrixClient()).toThrow(/No tenant context/)
  })

  it('tenant A and B get DISTINCT instances; the same tenant is cached', () => {
    const a = runWithTenant(ALPHA_CTX, () => getMatrixClient())
    const b = runWithTenant(BETA_CTX, () => getMatrixClient())
    expect(a).not.toBe(b)
    expect(runWithTenant(ALPHA_CTX, () => getMatrixClient())).toBe(a)
  })

  it('default tenant: built from env (URL + admin token byte-identical, services ignored)', async () => {
    await runWithTenant(DEFAULT_CTX, () => getMatrixClient().getRoomIdByAlias('#x:matrix.test'))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://matrix.test:8008/_matrix/client/v3/directory/room/' + encodeURIComponent('#x:matrix.test'),
    )
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer env-admin-token')
  })

  it('non-default tenant builds from its registry services (url + resolved admin token ref)', async () => {
    await runWithTenant(ALPHA_CTX, () => getMatrixClient().getRoomIdByAlias('#x:alpha.example.org'))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('http://matrix-alpha:8008/_matrix/client/v3/directory/room/')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer alpha-admin-token')
  })

  it('non-default tenant WITHOUT services falls back to env', async () => {
    await runWithTenant(BETA_CTX, () => getMatrixClient().getRoomIdByAlias('#y:matrix.test'))
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('http://matrix.test:8008/')
  })

  // Design v11 review: the m.room.name state read must go through the client's
  // OWN baseUrl — a non-default tenant's per-user token may never be sent to the
  // default homeserver (env MATRIX_URL).
  it("getRoomName targets the TENANT's homeserver with the USER token, never env MATRIX_URL", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ name: 'Vorstand' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const name = await runWithTenant(ALPHA_CTX, () =>
      getMatrixClient().getRoomName('user-token-alpha', '!r1:alpha.example.org'),
    )
    expect(name).toBe('Vorstand')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://matrix-alpha:8008/_matrix/client/v3/rooms/' +
        encodeURIComponent('!r1:alpha.example.org') +
        '/state/m.room.name',
    )
    expect(url).not.toContain('matrix.test')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer user-token-alpha')
  })

  it('getRoomName degrades to null when the state read fails (404)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errcode: 'M_NOT_FOUND' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const name = await runWithTenant(ALPHA_CTX, () =>
      getMatrixClient().getRoomName('user-token-alpha', '!r1:alpha.example.org'),
    )
    expect(name).toBeNull()
  })

  it('evictMatrixClient drops the tenant instance AND its token cache', async () => {
    const jwt = jwtWithSub('user-1')
    const before = runWithTenant(ALPHA_CTX, () => getMatrixClient())
    const t1 = await runWithTenant(ALPHA_CTX, () => getMatrixClient().getMatrixToken(jwt))
    const t2 = await runWithTenant(ALPHA_CTX, () => getMatrixClient().getMatrixToken(jwt))
    expect(t2).toBe(t1) // cached — one /login

    evictMatrixClient('tid-alpha')

    const after = runWithTenant(ALPHA_CTX, () => getMatrixClient())
    expect(after).not.toBe(before)
    const t3 = await runWithTenant(ALPHA_CTX, () => getMatrixClient().getMatrixToken(jwt))
    expect(t3).not.toBe(t1) // token cache for the tenant was purged → fresh /login
  })

  it('evicting tenant A leaves tenant B token cache intact', async () => {
    const jwt = jwtWithSub('user-2')
    const tB1 = await runWithTenant(BETA_CTX, () => getMatrixClient().getMatrixToken(jwt))
    evictMatrixClient('tid-alpha')
    const tB2 = await runWithTenant(BETA_CTX, () => getMatrixClient().getMatrixToken(jwt))
    expect(tB2).toBe(tB1)
  })
})

describe('getSynapseAdmin — per-tenant keyed registry (T7)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    __resetSynapseAdminForTests()
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('fail-closed: throws outside any tenant scope', () => {
    expect(() => getSynapseAdmin()).toThrow(/No tenant context/)
  })

  it('tenant A and B get DISTINCT instances; the same tenant is cached', () => {
    const a = runWithTenant(ALPHA_CTX, () => getSynapseAdmin())
    const b = runWithTenant(BETA_CTX, () => getSynapseAdmin())
    expect(a).not.toBe(b)
    expect(runWithTenant(ALPHA_CTX, () => getSynapseAdmin())).toBe(a)
  })

  it('default tenant: env base + env server name + env token (byte-identical, services ignored)', async () => {
    await runWithTenant(DEFAULT_CTX, () => getSynapseAdmin().createUser('bob', 'Bob'))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://matrix.test:8008/_synapse/admin/v2/users/' + encodeURIComponent('@bob:matrix.test'),
    )
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer env-admin-token')
  })

  it('non-default tenant: services base + server name + resolved admin token ref', async () => {
    await runWithTenant(ALPHA_CTX, () => getSynapseAdmin().createUser('bob', 'Bob'))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://matrix-alpha:8008/_synapse/admin/v2/users/' + encodeURIComponent('@bob:alpha.example.org'),
    )
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer alpha-admin-token')
  })

  it('evictSynapseAdmin drops only that tenant instance', () => {
    const a = runWithTenant(ALPHA_CTX, () => getSynapseAdmin())
    const b = runWithTenant(BETA_CTX, () => getSynapseAdmin())
    evictSynapseAdmin('tid-alpha')
    expect(runWithTenant(ALPHA_CTX, () => getSynapseAdmin())).not.toBe(a)
    expect(runWithTenant(BETA_CTX, () => getSynapseAdmin())).toBe(b)
  })
})
