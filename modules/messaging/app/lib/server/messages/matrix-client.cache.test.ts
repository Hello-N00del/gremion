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
  describe('TTL is fixed from mint time, independent of the Keycloak exp', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-01T00:00:00Z')) })
    afterEach(() => vi.useRealTimers())
    const jwtExpIn = (sub: string, sec: number) =>
      `h.${Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + sec })).toString('base64url')}.s`

    it('serves from cache past the Keycloak exp, re-logs-in after the TTL', async () => {
      const { getMatrixClient, __resetMatrixCachesForTests } = await import('./matrix-client')
      __resetMatrixCachesForTests()
      activeTenant = 'a'
      const jwt = jwtExpIn('ttl-user', 600)
      expect(await getMatrixClient().getMatrixToken(jwt)).toBe('mx-1')
      vi.advanceTimersByTime(15 * 60_000)
      expect(await getMatrixClient().getMatrixToken(jwt)).toBe('mx-1')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(46 * 60_000) // 61 min after mint
      const fresh = jwtExpIn('ttl-user', 600)
      expect(await getMatrixClient().getMatrixToken(fresh)).toBe('mx-2')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('still refuses to mint with an expired JWT and no cache entry', async () => {
      const { getMatrixClient, __resetMatrixCachesForTests } = await import('./matrix-client')
      __resetMatrixCachesForTests()
      activeTenant = 'a'
      await expect(getMatrixClient().getMatrixToken(jwtExpIn('gone', -10))).rejects.toThrow(/expired/)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})

describe('MatrixClient evicts a token Synapse has invalidated', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stub(failStatus: number, failBody: unknown) {
    let n = 0
    const f = vi.fn(async (url: string) => {
      if (String(url).includes('/login')) {
        return new Response(JSON.stringify({ access_token: `mx-${++n}` }), { status: 200 })
      }
      return new Response(JSON.stringify(failBody), { status: failStatus })
    })
    vi.stubGlobal('fetch', f)
    return f
  }
  const loginCalls = (f: ReturnType<typeof vi.fn>) =>
    f.mock.calls.filter((c) => String(c[0]).includes('/login')).length

  it.each([
    [401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Unrecognised access token.' }],
    [401, {}],
    [403, { errcode: 'M_UNKNOWN_TOKEN', error: 'x' }],
  ])('status %i %j on a user-token call evicts; next getMatrixToken re-exchanges', async (status, body) => {
    const f = stub(status, body)
    const { getMatrixClient, __resetMatrixCachesForTests } = await import('./matrix-client')
    __resetMatrixCachesForTests()
    activeTenant = 'a'
    const jwt = jwtWithSub('evict-me')
    const c = getMatrixClient()
    const tok = await c.getMatrixToken(jwt)
    await expect(c.getJoinedRooms(tok)).rejects.toThrow()
    expect(await c.getMatrixToken(jwt)).toBe('mx-2')
    expect(loginCalls(f)).toBe(2)
  })

  it('media upload 401 evicts the user token', async () => {
    const f = stub(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Unrecognised access token.' })
    const { getMatrixClient, __resetMatrixCachesForTests } = await import('./matrix-client')
    __resetMatrixCachesForTests()
    activeTenant = 'a'
    const jwt = jwtWithSub('evict-upload')
    const c = getMatrixClient()
    const tok = await c.getMatrixToken(jwt)
    await expect(c.uploadMedia(tok, new ArrayBuffer(4), 'image/png', 'a.png')).rejects.toThrow(/Media upload failed/)
    expect(await c.getMatrixToken(jwt)).toBe('mx-2')
    expect(loginCalls(f)).toBe(2)
  })

  it('an unrelated failure (500) does not evict', async () => {
    const f = stub(500, { error: 'boom' })
    const { getMatrixClient, __resetMatrixCachesForTests } = await import('./matrix-client')
    __resetMatrixCachesForTests()
    activeTenant = 'a'
    const jwt = jwtWithSub('keep-me')
    const c = getMatrixClient()
    const tok = await c.getMatrixToken(jwt)
    await expect(c.getJoinedRooms(tok)).rejects.toThrow()
    expect(await c.getMatrixToken(jwt)).toBe('mx-1')
    expect(loginCalls(f)).toBe(1)
  })
})
