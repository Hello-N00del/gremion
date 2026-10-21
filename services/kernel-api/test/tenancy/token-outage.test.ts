// TASK-077 residual: a verifier failure is 401 only when the TOKEN is bad
// (jose verification errors); a JWKS outage / network error is 503
// problem+json with Retry-After -- and never 200 (fail closed).
import { errors } from 'jose'
import { describe, expect, it } from 'vitest'
import { A_HOST, appWith, edge, world } from '../harness/fakes.ts'

const SELF = '/api/v1/tenancy/self'

async function call(err: unknown) {
  const { app, rec } = appWith(world(), { tokens: { async verify() { throw err } } })
  const res = await app.inject({ url: SELF, headers: edge(A_HOST, 'a-token') })
  await app.close()
  return { res, rec }
}

describe('token verification failure classes', () => {
  const bad: Array<[string, unknown]> = [
    ['JWTExpired', new errors.JWTExpired('x', { exp: 1 })],
    ['JWTClaimValidationFailed', new errors.JWTClaimValidationFailed('x', { iss: 'x' }, 'iss', 'check_failed')],
    ['JWSSignatureVerificationFailed', new errors.JWSSignatureVerificationFailed()],
    ['JWSInvalid', new errors.JWSInvalid('x')],
    ['JWTInvalid', new errors.JWTInvalid('x')],
    ['JOSEAlgNotAllowed', new errors.JOSEAlgNotAllowed('x')],
    ['JWKSNoMatchingKey', new errors.JWKSNoMatchingKey()],
  ]
  it.each(bad)('%s -> 401', async (_n, err) => {
    const { res } = await call(err)
    expect(res.statusCode).toBe(401)
  })

  const infra: Array<[string, unknown]> = [
    ['JWKSTimeout', new errors.JWKSTimeout()],
    ['fetch TypeError', new TypeError('fetch failed')],
    ['plain Error', new Error('ECONNREFUSED')],
    ['non-Error throw', 'boom'],
  ]
  it.each(infra)('%s -> 503 problem+json with Retry-After, never 200', async (_n, err) => {
    const { res, rec } = await call(err)
    expect(res.statusCode).toBe(503)
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/)
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    expect(res.json()).toMatchObject({ type: 'urn:gremion:problem:identity-unavailable', status: 503 })
    expect(rec.gateChecks).toEqual([])
  })

  it('logs the error class of an outage', async () => {
    const { rec } = await call(new errors.JWKSTimeout())
    expect(JSON.stringify(rec)).toContain('JWKSTimeout')
  })
})
