// TASK-043 TDD 15 (the pure gate): a customer-realm session is refused on a
// page, an action and a +server endpoint alike; a forged cookie is refused and
// cleared; the ops realm without loa2 is sent to step-up; loa2 is allowed.
import { describe, expect, it } from 'vitest'
import { decide, isExempt, type GateInput, type SessionClaims } from './gate'

const OPS = 'https://platform.example/auth/realms/platform'
const CUSTOMER = 'https://rat.musterstadt.example/auth/realms/musterstadt'
const OPERATOR_ID = '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33'

const ops = (over: Partial<SessionClaims> = {}): SessionClaims => ({ iss: OPS, acr: 'loa2', uid: OPERATOR_ID, email: 'ops@platform.example', roles: ['operator'], ...over })

function input(over: Partial<GateInput>): GateInput {
  return { method: 'GET', path: '/', session: null, sessionCookie: false, authorization: null, issuer: OPS, requiredAcr: 'loa2', ...over }
}

function jwt(payload: object): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b({ alg: 'none' })}.${b(payload)}.sig`
}

describe('decide (TRD-048)', () => {
  it.each([
    ['a page', 'GET', '/'],
    ['a form action', 'POST', '/customers/new'],
    ['a +server endpoint', 'GET', '/api/customers'],
  ])('a customer-realm session is 403 on %s', (_what, method, path) => {
    const d = decide(input({ method, path, session: ops({ iss: CUSTOMER }) }))
    expect(d).toMatchObject({ kind: 'refuse', status: 403 })
    expect((d as { reason: string }).reason).toContain(CUSTOMER)
  })

  it('a customer-realm session with loa2 AND the operator role is still 403 (the iss decides, not the acr)', () => {
    expect(decide(input({ session: ops({ iss: CUSTOMER, acr: 'loa2', roles: ['operator'] }) })).kind).toBe('refuse')
  })

  it('an issuer that differs by a trailing slash or case is 403 (exact match)', () => {
    expect(decide(input({ session: ops({ iss: `${OPS}/` }) })).kind).toBe('refuse')
    expect(decide(input({ session: ops({ iss: OPS.toUpperCase() }) })).kind).toBe('refuse')
  })

  it('a session cookie that does not decode (forged) is 403 and cleared, on GET and POST', () => {
    for (const method of ['GET', 'POST']) {
      expect(decide(input({ method, sessionCookie: true }))).toEqual({ kind: 'refuse', status: 403, reason: expect.stringMatching(/forged or stale/), clearCookie: true })
    }
  })

  it('anonymous: GET starts the sign-in at the ops realm, anything else is 403', () => {
    expect(decide(input({}))).toEqual({ kind: 'sign-in', reason: 'anonymous' })
    expect(decide(input({ method: 'POST', path: '/customers/new' })).kind).toBe('refuse')
  })

  it('the ops realm at loa1 is sent to step-up (GET) or refused (POST); loa2 is allowed', () => {
    expect(decide(input({ session: ops({ acr: 'loa1' }) }))).toEqual({ kind: 'sign-in', reason: 'step-up' })
    expect(decide(input({ method: 'POST', session: ops({ acr: 'loa1' }) })).kind).toBe('refuse')
    expect(decide(input({ session: ops() }))).toEqual({ kind: 'allow', operator: { id: OPERATOR_ID, email: 'ops@platform.example', iss: OPS, acr: 'loa2' } })
  })

  it('no operator role is 403', () => {
    expect(decide(input({ session: ops({ roles: [] }) })).kind).toBe('refuse')
  })

  it('any bearer token is 403, and a customer token is named', () => {
    const d = decide(input({ authorization: `Bearer ${jwt({ iss: CUSTOMER })}`, session: ops() }))
    expect(d.kind).toBe('refuse')
    expect((d as { reason: string }).reason).toContain(CUSTOMER)
    expect(decide(input({ authorization: `Bearer ${jwt({ iss: OPS })}` })).kind).toBe('refuse')
    expect(decide(input({ authorization: 'Basic abc' })).kind).toBe('refuse')
  })

  it('an errored session (expired refresh) is sent to sign-in on GET', () => {
    expect(decide(input({ session: ops({ error: 'RefreshTokenExpired' }) }))).toEqual({ kind: 'sign-in', reason: 'expired' })
  })
})

describe('isExempt', () => {
  it('exempts exactly the probes and the Auth.js routes', () => {
    for (const p of ['/healthz', '/api/internal/evict', '/auth/signin', '/auth/callback/keycloak']) expect(isExempt(p)).toBe(true)
    for (const p of ['/', '/customers/new', '/api/customers', '/healthz/x', '/authx', '/api/internal/evict2']) expect(isExempt(p)).toBe(false)
  })
})
