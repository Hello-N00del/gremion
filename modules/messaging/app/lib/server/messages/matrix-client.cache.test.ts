import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$env/dynamic/private', () => ({
  env: { MATRIX_URL: 'http://matrix.test:8008', SYNAPSE_ADMIN_TOKEN: 'adm', SYNAPSE_ADMIN_BOT_USER_ID: '@bot:matrix.test' },
}))
let activeTenant = 'a'
// P2.1b T7: getMatrixClient() also reads getTenant() (per-tenant instance
// registry). slug 'default' keeps env-based construction; the ID still flips
// between tenants so the token-cache isolation under test is unchanged.
vi.mock('$lib/server/tenant/context', () => ({
  currentTenantId: () => activeTenant,
  getTenant: () => ({ id: activeTenant, slug: 'default' }),
}))

function jwtWithSub(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
  return `h.${payload}.s`
}

describe('MatrixClient token cache tenant isolation', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    let n = 0
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: `mx-${++n}` }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('does not serve tenant A Matrix token to tenant B for the same sub', async () => {
    const { getMatrixClient, __resetMatrixCachesForTests } = await import('./matrix-client')
    __resetMatrixCachesForTests()
    const jwt = jwtWithSub('shared-sub')
    activeTenant = 'a'; const a = await getMatrixClient().getMatrixToken(jwt)
    activeTenant = 'b'; const b = await getMatrixClient().getMatrixToken(jwt)
    expect(a).toBe('mx-1')
    expect(b).toBe('mx-2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('still caches within one tenant for the same sub', async () => {
    const { getMatrixClient, __resetMatrixCachesForTests } = await import('./matrix-client')
    __resetMatrixCachesForTests()
    const jwt = jwtWithSub('same')
    activeTenant = 'a'
    const first = await getMatrixClient().getMatrixToken(jwt)
    const second = await getMatrixClient().getMatrixToken(jwt)
    expect(first).toBe('mx-1'); expect(second).toBe('mx-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
