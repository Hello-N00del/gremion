// TDD 4 (tokens), brief s.1 "Cross-realm", lane A half (A2): the REAL jose
// verifier against two local issuers. B's token on A's host is 401
// problem+json with no data read; a token without the gremion-kernel-api
// audience, a non-RS256 one and an expired one are 401; the JWKS cache is
// keyed (customerId, issuer) and bounded. RED reference: a key-set union with
// no issuer pin would accept a token B signs with A's issuer.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTokenVerifier, jwksUrl, KERNEL_API_AUDIENCE } from '../../src/tenancy/tokens.ts'
import { A_HOST, A_ID, appWith, B_ID, edge, tenantRow, world, type FakeWorld } from '../harness/fakes.ts'
import { startIssuers, type Issuers } from '../harness/issuers.ts'

const SELF = '/api/v1/tenancy/self'
let iss: Issuers

beforeAll(async () => {
  iss = await startIssuers(['realm-a', 'realm-b'])
})
afterAll(() => iss.close())

function realWorld(): FakeWorld {
  const w = world()
  const a = iss.realms.get('realm-a')!
  const b = iss.realms.get('realm-b')!
  w.tenants.set(A_ID, tenantRow(A_ID, 'a', 'active', { realm: 'realm-a', issuer: a.issuer, kcInternal: a.kcInternal }))
  w.tenants.set(B_ID, tenantRow(B_ID, 'council-b', 'active', { realm: 'realm-b', issuer: b.issuer, kcInternal: b.kcInternal }))
  return w
}

function app(w = realWorld()) {
  return appWith(w, { tokens: createTokenVerifier() })
}

describe('bearer tokens on the host path (TDD 4, Q7)', () => {
  it("A's realm token on A's host -> 200", async () => {
    const { app: a } = app()
    const res = await a.inject({ url: SELF, headers: edge(A_HOST, await iss.mint('realm-a')) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ customerId: A_ID, realm: 'realm-a' })
    await a.close()
  })

  it("B's token on A's host -> 401 problem+json, no data read (gate never consulted)", async () => {
    const { app: a, rec } = app()
    const res = await a.inject({ url: SELF, headers: edge(A_HOST, await iss.mint('realm-b')) })
    expect(res.statusCode).toBe(401)
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/)
    expect(res.json()).toMatchObject({ type: 'urn:gremion:problem:unauthorized', status: 401 })
    expect(rec.gateChecks).toEqual([])
    expect(rec.registryReads).toEqual([])
    await a.close()
  })

  it("RED reference (JWKS union without issuer pin): B's key signing A's issuer is refused -- A's keys only", async () => {
    const { app: a, rec } = app()
    const forged = await iss.mint('realm-b', { iss: iss.realms.get('realm-a')!.issuer }, { kid: iss.realms.get('realm-a')!.jwk.kid })
    const res = await a.inject({ url: SELF, headers: edge(A_HOST, forged) })
    expect(res.statusCode).toBe(401)
    expect(rec.gateChecks).toEqual([])
    await a.close()
  })

  it.each([
    ['no gremion-kernel-api in aud (a gremion-ui-only token)', async () => iss.mint('realm-a', { aud: ['gremion-ui', 'account'] })],
    ['aud as a bare other string', async () => iss.mint('realm-a', { aud: 'gremion-ui' })],
    ['expired', async () => iss.mint('realm-a', {}, { exp: Math.floor(Date.now() / 1000) - 3600 })],
    ['not yet valid', async () => iss.mint('realm-a', {}, { nbf: Math.floor(Date.now() / 1000) + 3600 })],
    ['HS256 with a shared secret', async () => iss.mint('realm-a', {}, { alg: 'HS256', key: new TextEncoder().encode('x'.repeat(32)) })],
    ['alg none', async () => `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: iss.realms.get('realm-a')!.issuer, aud: KERNEL_API_AUDIENCE, sub: 'x', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.`],
    ['a wrong issuer on the right key', async () => iss.mint('realm-a', { iss: 'https://a.example.org/realms/other' })],
    ['garbage', async () => 'not.a.jwt'],
  ])('%s -> 401', async (_n, make) => {
    const { app: a, rec } = app()
    const res = await a.inject({ url: SELF, headers: edge(A_HOST, await make()) })
    expect(res.statusCode).toBe(401)
    expect(rec.gateChecks).toEqual([])
    await a.close()
  })

  it('no Authorization header, or not a Bearer one -> 401 with WWW-Authenticate: Bearer', async () => {
    const { app: a } = app()
    const none = await a.inject({ url: SELF, headers: edge(A_HOST) })
    expect(none.statusCode).toBe(401)
    expect(none.headers['www-authenticate']).toBe('Bearer')
    const basic = await a.inject({ url: SELF, headers: edge(A_HOST, undefined, { authorization: 'Basic dXNlcjpwdw==' }) })
    expect(basic.statusCode).toBe(401)
    await a.close()
  })
})

describe('the JWKS cache (Q7)', () => {
  it('is keyed by (customerId, issuer): one fetch per customer, an issuer change gets a fresh set', async () => {
    const v = createTokenVerifier()
    const a = realWorld().tenants.get(A_ID)!
    const before = iss.fetches.get('realm-a') ?? 0
    await v.verify(await iss.mint('realm-a'), a)
    await v.verify(await iss.mint('realm-a'), a)
    expect(iss.fetches.get('realm-a')! - before).toBe(1)
    expect(v.cacheSize()).toBe(1)
    // the same realm under another customer id is a separate entry (never shared across customers)
    await v.verify(await iss.mint('realm-a'), { ...a, customerId: B_ID })
    expect(v.cacheSize()).toBe(2)
  })

  it('is bounded: the least recently used key set is dropped past maxKeySets', async () => {
    let made = 0
    const v = createTokenVerifier({ maxKeySets: 2, keySetFor: () => (made++, async () => { throw new Error('no key') }) })
    const t = realWorld().tenants.get(A_ID)!
    for (const id of ['0192f0c1-2b3c-7d4e-8f00-000000000001', '0192f0c1-2b3c-7d4e-8f00-000000000002', '0192f0c1-2b3c-7d4e-8f00-000000000003']) {
      await v.verify('x.y.z', { ...t, customerId: id }).catch(() => undefined)
    }
    expect(v.cacheSize()).toBe(2)
    expect(made).toBe(3)
  })

  it('derives the JWKS URL from kc_internal, refusing a non-http scheme', () => {
    expect(jwksUrl({ kcInternal: 'http://keycloak:8080/realms/r/' }).href).toBe('http://keycloak:8080/realms/r/protocol/openid-connect/certs')
    expect(() => jwksUrl({ kcInternal: 'file:///etc/passwd' })).toThrow(/http/)
  })
})
