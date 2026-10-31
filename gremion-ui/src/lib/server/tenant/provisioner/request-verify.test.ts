// TASK-043d-1 TDD 9: the trusted-layer re-verification of a panel request's
// evidence (D4, ASVS 4.0.3 V4.1.1). The evidence is the PAIR of signed tokens
// of ONE code exchange of the ops realm (measured on Keycloak 26.6.1,
// test/host/fixtures/executor/kc2661-token-claims.json): the ID token carries
// sub, acr, aud/azp and iat but no realm roles; the access token carries the
// realm roles but no sub; neither carries auth_time. They are bound by the ID
// token's at_hash (OIDC Core 3.1.3.6) and their shared sid. A local JWKS
// fixture key pair signs them here; nothing is fetched.
import { createHash } from 'node:crypto'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { encodeEvidence, verifyRequestEvidence, type EvidenceCheck } from './request-verify'

const ISS = 'https://platform.example/auth/realms/platform'
const OPERATOR = '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33'
const CREATED = new Date('2026-10-05T12:00:00Z')
const T = Math.floor(CREATED.getTime() / 1000)

let priv: CryptoKey
let otherPriv: CryptoKey
let jwks: ReturnType<typeof createLocalJWKSet>

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true })
  priv = kp.privateKey
  const jwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  jwks = createLocalJWKSet({ keys: [jwk] })
  otherPriv = (await generateKeyPair('RS256', { extractable: true })).privateKey
})

const atHash = (accessToken: string) => createHash('sha256').update(accessToken, 'ascii').digest().subarray(0, 16).toString('base64url')

interface Over {
  id?: Record<string, unknown>
  at?: Record<string, unknown>
  /** sign the ID token with a key that is not in the JWKS */
  otherKey?: boolean
  atHashOf?: string
}

async function pair(o: Over = {}): Promise<{ id: string; access: string }> {
  const sign = (claims: Record<string, unknown>, key: CryptoKey) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: 'JWT' }).sign(key)
  const access = await sign(
    { iss: ISS, aud: 'control-panel', azp: 'control-panel', typ: 'Bearer', acr: 'loa2', sid: 's-1', iat: T - 600, exp: T - 300, realm_access: { roles: ['operator', 'default-roles-platform'] }, ...o.at },
    priv,
  )
  const id = await sign(
    { iss: ISS, aud: 'control-panel', azp: 'control-panel', typ: 'ID', acr: 'loa2', sid: 's-1', sub: OPERATOR, iat: T - 600, exp: T - 300, at_hash: atHash(o.atHashOf ?? access), ...o.id },
    o.otherKey ? otherPriv : priv,
  )
  return { id, access }
}

const check = (evidence: string, over: Partial<EvidenceCheck> = {}): EvidenceCheck => ({
  evidence,
  jwks,
  issuer: ISS,
  clientId: 'control-panel',
  operatorId: OPERATOR,
  createdAt: CREATED,
  recordedAuthTime: new Date((T - 600) * 1000),
  ...over,
})

describe('verifyRequestEvidence', () => {
  it('a valid pair verifies: subject, acr, the sign-in time it used', async () => {
    const r = await verifyRequestEvidence(check(encodeEvidence(await pair())))
    expect(r).toEqual({ ok: true, sub: OPERATOR, acr: 'loa2', authTime: T - 600, timeClaim: 'iat' })
  })

  it('auth_time is used when the token carries it', async () => {
    const r = await verifyRequestEvidence(check(encodeEvidence(await pair({ id: { auth_time: T - 900 } })), { recordedAuthTime: new Date((T - 900) * 1000) }))
    expect(r).toMatchObject({ ok: true, authTime: T - 900, timeClaim: 'auth_time' })
  })

  it.each<[string, Over, Partial<EvidenceCheck>, RegExp]>([
    ['a wrong issuer', { id: { iss: 'https://rat.musterstadt.example/auth/realms/musterstadt' } }, {}, /issuer|iss/],
    ['a wrong subject', { id: { sub: '00000000-0000-4000-8000-000000000000' } }, {}, /sub .* is not the request's operator/],
    ['acr loa1 (ID token)', { id: { acr: 'loa1' } }, {}, /acr loa1/],
    ['acr loa1 (access token)', { at: { acr: 'loa1' } }, {}, /acr loa1/],
    ['no operator realm role', { at: { realm_access: { roles: ['default-roles-platform'] } } }, {}, /operator role/],
    ['a sign-in 3601 s before the request', { id: { iat: T - 3601 } }, { recordedAuthTime: new Date((T - 3601) * 1000) }, /3601 s before the request/],
    ['an ID token signed by another key', { otherKey: true }, {}, /signature/],
    ['an access token from another exchange (at_hash)', { atHashOf: 'eyJhbGciOiJSUzI1NiJ9.e30.other' }, {}, /at_hash/],
    ['two ID tokens (typ)', { at: { typ: 'ID' } }, {}, /typ/],
    ['another client (azp)', { id: { azp: 'grafana' } }, {}, /azp/],
    ['the sessions differ (sid)', { at: { sid: 's-2' } }, {}, /sid/],
    ['a recorded sign-in time that is not the token\'s', {}, { recordedAuthTime: new Date((T - 100) * 1000) }, /recorded sign-in time/],
  ])('refused: %s', async (_what, o, c, why) => {
    const r = await verifyRequestEvidence(check(encodeEvidence(await pair(o)), c))
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.reason).toMatch(why)
  })

  it('refused: a tampered signature, an unsigned (alg none) token, and evidence that is not a pair', async () => {
    const p = await pair()
    const [h, b, s] = p.id.split('.') as [string, string, string]
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b, 'base64url').toString()), sub: OPERATOR, acr: 'loa2', extra: 1 })).toString('base64url')}.${s}`
    expect(await verifyRequestEvidence(check(encodeEvidence({ ...p, id: tampered })))).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) })
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${b}.`
    expect(await verifyRequestEvidence(check(encodeEvidence({ ...p, id: none })))).toMatchObject({ ok: false, reason: expect.stringMatching(/alg|Unsupported|JWS/i) })
    expect(await verifyRequestEvidence(check('not json'))).toMatchObject({ ok: false, reason: expect.stringMatching(/not the token pair/) })
    expect(await verifyRequestEvidence(check(JSON.stringify({ id: p.id })))).toMatchObject({ ok: false, reason: expect.stringMatching(/not the token pair/) })
  })

  it('the pair it stores is ONE string the database bound (100..8192 characters) accepts', async () => {
    const e = encodeEvidence(await pair())
    expect(e.length).toBeGreaterThanOrEqual(100)
    expect(e.length).toBeLessThanOrEqual(8192)
  })
})

// Karenz phase 1, Task 5: the same code path verifies a council admin's pair of
// ANOTHER realm and client when the check names the role it requires.
describe('verifyRequestEvidence: requiredRole', () => {
  const COUNCIL_ISS = 'https://rat.example/auth/realms/musterstadt'
  const councilCheck = async (roles: string[], requiredRole: string | readonly string[] | undefined) => {
    const p = await pair({ id: { iss: COUNCIL_ISS, aud: 'gremion-ui', azp: 'gremion-ui' }, at: { iss: COUNCIL_ISS, aud: 'gremion-ui', azp: 'gremion-ui', realm_access: { roles } } })
    return verifyRequestEvidence(check(encodeEvidence(p), { issuer: COUNCIL_ISS, clientId: 'gremion-ui', ...(requiredRole === undefined ? {} : { requiredRole }) }))
  }

  it('accepts a pair whose access token carries the required role', async () => {
    expect(await councilCheck(['council-admin'], 'council-admin')).toMatchObject({ ok: true, sub: OPERATOR })
  })

  it('refuses a pair that lacks the required role, naming it', async () => {
    const r = await councilCheck(['operator', 'member'], 'council-admin')
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.reason).toMatch(/council-admin/)
  })

  it('a list of roles is any-of', async () => {
    expect(await councilCheck(['it-admin'], ['council-admin', 'it-admin'])).toMatchObject({ ok: true })
    expect((await councilCheck(['member'], ['council-admin', 'it-admin'])).ok).toBe(false)
  })

  it('without requiredRole the default stays the operator role (the panel path)', async () => {
    expect((await councilCheck(['council-admin'], undefined)).ok).toBe(false)
    expect(await councilCheck(['operator'], undefined)).toMatchObject({ ok: true })
    const r = await verifyRequestEvidence(check(encodeEvidence(await pair({ at: { realm_access: { roles: ['default-roles-platform'] } } }))))
    expect(r.ok ? '' : r.reason).toBe('the access token carries no operator role of the ops realm')
  })
})
