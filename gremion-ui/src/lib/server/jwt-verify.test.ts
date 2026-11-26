// @vitest-environment node
// Real RS256 SignJWT/generateKeyPair require a single JS realm: jose's sign path
// guards `payload instanceof Uint8Array`, which fails under jsdom's cross-realm
// typed arrays (the codebase's established idiom — see e.g. sepa-backend.test.ts).
import { describe, it, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'

const envMock: Record<string, string> = {}
vi.mock('$env/dynamic/private', () => ({ env: envMock }))

type TenantAuth = { id: string; issuer: string; kcInternal: string; audiences: string[] }
const ISS_A = 'https://kc.example.org/realms/tenant-a'
const ISS_B = 'https://kc.example.org/realms/tenant-b'

async function mintToken(priv: CryptoKey, kid: string, iss: string, aud: string) {
  return new SignJWT({ sub: 'user-1' })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime('5m').sign(priv)
}

describe('verifyBearerJwt(token, tenant)', () => {
  // JWK objects carry kid/use/alg on top of the base JsonWebKey shape; widen to
  // Record so the literal type-checks (they are only JSON-serialised below).
  let pubA: Record<string, unknown>, privA: CryptoKey, pubB: Record<string, unknown>, privB: CryptoKey
  // Loosely typed: vi.spyOn(fetch) yields a fetch-typed MockInstance whose generic
  // clashes with ReturnType<typeof vi.spyOn>; only .mock.calls is read here.
  let fetchSpy: ReturnType<typeof vi.fn>
  beforeEach(async () => {
    vi.resetModules()
    const a = await generateKeyPair('RS256'); privA = a.privateKey
    pubA = { ...(await exportJWK(a.publicKey)), kid: 'a1', use: 'sig', alg: 'RS256' }
    const b = await generateKeyPair('RS256'); privB = b.privateKey
    pubB = { ...(await exportJWK(b.publicKey)), kid: 'b1', use: 'sig', alg: 'RS256' }
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      // typescript(no-base-to-string): url's real type is RequestInfo | URL;
      // a bare String(url) on a Request would yield '[object Request]'
      // instead of its .url, silently defaulting every case to pubB.
      const target = url instanceof URL ? url.href : typeof url === 'string' ? url : (url as Request).url
      const keys = target.includes('tenant-a') ? [pubA] : [pubB]
      return new Response(JSON.stringify({ keys }), { headers: { 'content-type': 'application/json' } })
    }) as unknown as ReturnType<typeof vi.fn>
  })
  const tenantA: TenantAuth = { id: 'a', issuer: ISS_A, kcInternal: ISS_A, audiences: ['gremion-ui'] }
  const tenantB: TenantAuth = { id: 'b', issuer: ISS_B, kcInternal: ISS_B, audiences: ['gremion-ui'] }

  it('accepts a token minted for the tenant and returns its payload', async () => {
    const { verifyBearerJwt } = await import('./jwt-verify')
    const payload = await verifyBearerJwt(await mintToken(privA, 'a1', ISS_A, 'gremion-ui'), tenantA)
    expect(payload?.sub).toBe('user-1'); expect(payload?.iss).toBe(ISS_A)
  })
  it('rejects a tenant-A token replayed against tenant B (iss mismatch)', async () => {
    const { verifyBearerJwt } = await import('./jwt-verify')
    expect(await verifyBearerJwt(await mintToken(privA, 'a1', ISS_A, 'gremion-ui'), tenantB)).toBeNull()
  })
  it('uses a SEPARATE JWKS per issuer', async () => {
    const { verifyBearerJwt } = await import('./jwt-verify')
    await verifyBearerJwt(await mintToken(privA, 'a1', ISS_A, 'gremion-ui'), tenantA)
    await verifyBearerJwt(await mintToken(privB, 'b1', ISS_B, 'gremion-ui'), tenantB)
    const fetched = fetchSpy.mock.calls.map((c) => String(c[0]))
    expect(fetched.some((u) => u.includes('tenant-a'))).toBe(true)
    expect(fetched.some((u) => u.includes('tenant-b'))).toBe(true)
  })
  it('caches the JWKS per issuer (second verify on A re-uses the cached set)', async () => {
    const { verifyBearerJwt } = await import('./jwt-verify')
    await verifyBearerJwt(await mintToken(privA, 'a1', ISS_A, 'gremion-ui'), tenantA)
    const after1 = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('tenant-a')).length
    await verifyBearerJwt(await mintToken(privA, 'a1', ISS_A, 'gremion-ui'), tenantA)
    const after2 = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('tenant-a')).length
    expect(after2).toBe(after1)
  })
  it('returns null on empty token', async () => {
    const { verifyBearerJwt } = await import('./jwt-verify')
    expect(await verifyBearerJwt('', tenantA)).toBeNull()
  })

  // P2.1b T8: evictTenantRuntime (tenant suspend/delete) must be able to drop
  // ONE tenant's cached JWKS without touching any other tenant's.
  it("T8: evictJwks(tenantId) drops only that tenant's cached JWKS", async () => {
    const { verifyBearerJwt, evictJwks } = await import('./jwt-verify')
    await verifyBearerJwt(await mintToken(privA, 'a1', ISS_A, 'gremion-ui'), tenantA)
    await verifyBearerJwt(await mintToken(privB, 'b1', ISS_B, 'gremion-ui'), tenantB)
    const aFetches = () => fetchSpy.mock.calls.filter((c) => String(c[0]).includes('tenant-a')).length
    const bFetches = () => fetchSpy.mock.calls.filter((c) => String(c[0]).includes('tenant-b')).length
    const a1 = aFetches()
    const b1 = bFetches()
    evictJwks('a')
    // A re-fetches its key set (cache dropped); B's stays cached.
    expect((await verifyBearerJwt(await mintToken(privA, 'a1', ISS_A, 'gremion-ui'), tenantA))?.sub).toBe('user-1')
    expect((await verifyBearerJwt(await mintToken(privB, 'b1', ISS_B, 'gremion-ui'), tenantB))?.sub).toBe('user-1')
    expect(aFetches()).toBe(a1 + 1)
    expect(bFetches()).toBe(b1)
  })

  // P2.1b T6 (D-JWKS): the cache key is the canonical tenant.id, NOT the issuer.
  // Two tenants sharing a realm/issuer (same-realm fixture) must each verify
  // against their OWN key set — an issuer-keyed cache would serve tenant A's
  // keys for tenant B and reject B's perfectly valid token.
  it('D-JWKS: two tenants sharing an ISSUER do not collide (cache keyed by tenant.id)', async () => {
    const ISS_SHARED = 'https://kc.example.org/realms/shared'
    const sharedA: TenantAuth = { id: 'tid-a', issuer: ISS_SHARED, kcInternal: 'http://kc-internal-a:8080/realms/shared', audiences: ['gremion-ui'] }
    const sharedB: TenantAuth = { id: 'tid-b', issuer: ISS_SHARED, kcInternal: 'http://kc-internal-b:8080/realms/shared', audiences: ['gremion-ui'] }
    fetchSpy.mockImplementation(async (url: unknown) => {
      const keys = String(url).includes('kc-internal-a') ? [pubA] : [pubB]
      return new Response(JSON.stringify({ keys }), { headers: { 'content-type': 'application/json' } })
    })
    const { verifyBearerJwt } = await import('./jwt-verify')
    const a = await verifyBearerJwt(await mintToken(privA, 'a1', ISS_SHARED, 'gremion-ui'), sharedA)
    expect(a?.sub).toBe('user-1')
    const b = await verifyBearerJwt(await mintToken(privB, 'b1', ISS_SHARED, 'gremion-ui'), sharedB)
    expect(b?.sub).toBe('user-1')
    const fetched = fetchSpy.mock.calls.map((c) => String(c[0]))
    expect(fetched.some((u) => u.includes('kc-internal-a'))).toBe(true)
    expect(fetched.some((u) => u.includes('kc-internal-b'))).toBe(true)
  })
})

// A key-set outage and a rejected token are told apart (verifyBearerJwtResult); verifyBearerJwt keeps
// answering null for both, which is what the request hook relies on.
describe('verifyBearerJwtResult(token, tenant, options)', () => {
  let pub: Record<string, unknown>, priv: CryptoKey, other: CryptoKey
  let keyEndpoint: () => Promise<Response>
  const tenant: TenantAuth = { id: 'tid-a', issuer: ISS_A, kcInternal: ISS_A, audiences: ['gremion-ui'] }
  beforeEach(async () => {
    vi.resetModules()
    const a = await generateKeyPair('RS256'); priv = a.privateKey
    pub = { ...(await exportJWK(a.publicKey)), kid: 'a1', use: 'sig', alg: 'RS256' }
    other = (await generateKeyPair('RS256')).privateKey
    keyEndpoint = async () => new Response(JSON.stringify({ keys: [pub] }), { headers: { 'content-type': 'application/json' } })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => keyEndpoint())
  })
  const expiring = (offsetSeconds: number, key: CryptoKey = priv) =>
    new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'a1' })
      .setIssuer(ISS_A).setAudience('gremion-ui')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) + offsetSeconds)
      .sign(key)

  test('a good token answers ok with its payload', async () => {
    const { verifyBearerJwtResult } = await import('./jwt-verify')
    const r = await verifyBearerJwtResult(await expiring(300), tenant)
    expect(r).toMatchObject({ ok: true, payload: { sub: 'user-1', iss: ISS_A } })
  })

  test('a token signed by another key, for another audience, or without a token is rejected, not an outage', async () => {
    const { verifyBearerJwtResult } = await import('./jwt-verify')
    expect(await verifyBearerJwtResult(await expiring(300, other), tenant)).toEqual({ ok: false, reason: 'rejected' })
    const wrongAud = await new SignJWT({ sub: 'u' }).setProtectedHeader({ alg: 'RS256', kid: 'a1' })
      .setIssuer(ISS_A).setAudience('some-other-client').setExpirationTime('5m').sign(priv)
    expect(await verifyBearerJwtResult(wrongAud, tenant)).toEqual({ ok: false, reason: 'rejected' })
    expect(await verifyBearerJwtResult('', tenant)).toEqual({ ok: false, reason: 'rejected' })
    expect(await verifyBearerJwtResult('not-a-jwt', tenant)).toEqual({ ok: false, reason: 'rejected' })
  })

  test('a token signed under a key id the key set does not list is rejected, not an outage', async () => {
    const { verifyBearerJwtResult } = await import('./jwt-verify')
    const unknownKid = await new SignJWT({ sub: 'u' }).setProtectedHeader({ alg: 'RS256', kid: 'zz9' })
      .setIssuer(ISS_A).setAudience('gremion-ui').setExpirationTime('5m').sign(priv)
    expect(await verifyBearerJwtResult(unknownKid, tenant)).toEqual({ ok: false, reason: 'rejected' })
  })

  test('an expired token is rejected, unless the caller grants a clock tolerance that covers it', async () => {
    const { verifyBearerJwtResult } = await import('./jwt-verify')
    const tenSecondsAgo = await expiring(-10)
    expect(await verifyBearerJwtResult(tenSecondsAgo, tenant)).toEqual({ ok: false, reason: 'rejected' })
    expect(await verifyBearerJwtResult(tenSecondsAgo, tenant, { clockToleranceSeconds: 60 })).toMatchObject({ ok: true })
    expect(await verifyBearerJwtResult(await expiring(-61), tenant, { clockToleranceSeconds: 60 })).toEqual({ ok: false, reason: 'rejected' })
  })

  test('a key endpoint that answers 500 is an outage, with the jose error code', async () => {
    keyEndpoint = async () => new Response('boom', { status: 500 })
    const { verifyBearerJwtResult } = await import('./jwt-verify')
    expect(await verifyBearerJwtResult(await expiring(300), tenant)).toEqual({ ok: false, reason: 'keys_unavailable', code: 'ERR_JOSE_GENERIC' })
  })

  test('a key endpoint that cannot be reached is an outage', async () => {
    keyEndpoint = async () => { throw new TypeError('fetch failed') }
    const { verifyBearerJwtResult } = await import('./jwt-verify')
    expect(await verifyBearerJwtResult(await expiring(300), tenant)).toEqual({ ok: false, reason: 'keys_unavailable', code: 'TypeError', detail: 'fetch failed' })
  })

  // undici reports a refused connection, a failed lookup and a TLS error alike as `TypeError: fetch failed`;
  // the reason is only in `err.cause.code`. The bounded code stays the error name, the detail names the reason.
  test.each(['ECONNREFUSED', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'])('a failed fetch carries its cause code (%s) as the detail', async (causeCode) => {
    const cause = Object.assign(new Error('connect failed to 10.0.0.9:8443'), { code: causeCode })
    keyEndpoint = async () => { throw new TypeError('fetch failed', { cause }) }
    const { verifyBearerJwtResult } = await import('./jwt-verify')
    expect(await verifyBearerJwtResult(await expiring(300), tenant)).toEqual({ ok: false, reason: 'keys_unavailable', code: 'TypeError', detail: causeCode })
  })

  test('an aborted fetch without a cause code gets its message as the detail, cut to 120 characters on one line', async () => {
    keyEndpoint = async () => { throw Object.assign(new Error(['aborted', 'x'.repeat(300)].join(String.fromCharCode(10))), { name: 'AbortError' }) }
    const { verifyBearerJwtResult } = await import('./jwt-verify')
    const r = await verifyBearerJwtResult(await expiring(300), tenant)
    expect(r).toMatchObject({ ok: false, reason: 'keys_unavailable', code: 'AbortError' })
    const detail = (r as { detail?: string }).detail ?? ''
    expect(detail.startsWith('aborted x')).toBe(true)
    expect(detail.length).toBeLessThanOrEqual(120)
    expect(detail.includes(String.fromCharCode(10))).toBe(false)
  })

  test('the detail never carries the token, even when an error message quotes it', async () => {
    const jwt = await expiring(300)
    keyEndpoint = async () => { throw Object.assign(new Error(`request for ${jwt} failed`), { name: 'AbortError' }) }
    const { verifyBearerJwtResult } = await import('./jwt-verify')
    const r = await verifyBearerJwtResult(jwt, tenant)
    expect(r).toMatchObject({ ok: false, reason: 'keys_unavailable' })
    // The detail is cut short, so the whole token could never fit: look for its first segment, which would.
    expect(JSON.stringify(r)).not.toContain(jwt.split('.')[0] ?? 'x')
    expect(JSON.stringify(r)).toContain('[token]')
  })

  describe('an error that is neither a key set problem nor a failed fetch', () => {
    let logged: string[]
    beforeEach(() => {
      logged = []
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map((a) => String(a)).join(' ')) })
    })
    afterEach(() => { vi.restoreAllMocks() })

    test('is logged (it is a defect in the code, not an outage) and still answers keys_unavailable', async () => {
      keyEndpoint = async () => { throw new TypeError("Cannot read properties of undefined (reading 'keys')") }
      const { verifyBearerJwtResult } = await import('./jwt-verify')
      const r = await verifyBearerJwtResult(await expiring(300), tenant)
      expect(r).toEqual({ ok: false, reason: 'keys_unavailable', code: 'TypeError', detail: "Cannot read properties of undefined (reading 'keys')" })
      expect(logged.some((l) => l.includes('[jwt-verify]') && l.includes("reading 'keys'"))).toBe(true)
    })

    test('is logged without the token', async () => {
      const jwt = await expiring(300)
      keyEndpoint = async () => { throw new RangeError(`bad input ${jwt}`) }
      const { verifyBearerJwtResult } = await import('./jwt-verify')
      await verifyBearerJwtResult(jwt, tenant)
      expect(logged.length).toBeGreaterThan(0)
      expect(logged.join(' ')).not.toContain(jwt.split('.')[0] ?? 'x')
    })

    test('a plain network failure and a key set answer that is no key set are not logged here (the caller names the tenant and logs them)', async () => {
      keyEndpoint = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }) }
      const { verifyBearerJwtResult } = await import('./jwt-verify')
      await verifyBearerJwtResult(await expiring(300), tenant)
      keyEndpoint = async () => new Response('boom', { status: 500 })
      const { __resetJwksCache } = await import('./jwt-verify')
      __resetJwksCache()
      await verifyBearerJwtResult(await expiring(300), tenant)
      expect(logged).toEqual([])
    })
  })

  test('a key endpoint that answers something that is no key set is an outage', async () => {
    keyEndpoint = async () => new Response(JSON.stringify({ nope: true }), { headers: { 'content-type': 'application/json' } })
    const { verifyBearerJwtResult } = await import('./jwt-verify')
    expect(await verifyBearerJwtResult(await expiring(300), tenant)).toEqual({ ok: false, reason: 'keys_unavailable', code: 'ERR_JWKS_INVALID' })
  })

  test('verifyBearerJwt still answers null for an outage and for a rejection alike', async () => {
    const { verifyBearerJwt } = await import('./jwt-verify')
    expect(await verifyBearerJwt(await expiring(300, other), tenant)).toBeNull()
    keyEndpoint = async () => new Response('boom', { status: 500 })
    const { __resetJwksCache } = await import('./jwt-verify')
    __resetJwksCache()
    expect(await verifyBearerJwt(await expiring(300), tenant)).toBeNull()
  })

  test('verifyBearerJwt grants no clock tolerance: a token that expired a second ago is null', async () => {
    const { verifyBearerJwt } = await import('./jwt-verify')
    expect(await verifyBearerJwt(await expiring(-1), tenant)).toBeNull()
  })
})
