// @vitest-environment node
// Real RS256 SignJWT/generateKeyPair require a single JS realm: jose's sign path
// guards `payload instanceof Uint8Array`, which fails under jsdom's cross-realm
// typed arrays (the codebase's established idiom — see e.g. sepa-backend.test.ts).
import { describe, it, expect, beforeEach, vi } from 'vitest'
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
      const keys = String(url).includes('tenant-a') ? [pubA] : [pubB]
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
