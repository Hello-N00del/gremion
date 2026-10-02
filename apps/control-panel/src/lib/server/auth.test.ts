// Review r2 HIGH (ASVS 5.0 V7.3.2): the panel's session has an ABSOLUTE
// lifetime. Auth.js 0.41 re-encodes a JWT session with a fresh expiry on every
// read (lib/actions/session.js), so `maxAge` alone is an idle timeout and one
// open tab (the status page polls every 5 s) would keep a revoked operator's
// session, or a stolen cookie, alive forever. The jwt callback stamps the
// sign-in time once and returns null (Auth.js then clears the cookie) once
// that time is more than SESSION_ABSOLUTE_SECONDS old.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JWT } from '@auth/core/jwt'
import { authConfig } from './auth'
import type { PanelConfig } from './config'
import { SESSION_ABSOLUTE_SECONDS } from './gate'

const NOW = 1_790_000_000

const config: PanelConfig = {
  origin: 'http://127.0.0.1:3043',
  issuer: 'https://platform.example/auth/realms/platform',
  internalBase: 'http://keycloak:8080/auth',
  realm: 'platform',
  clientId: 'control-panel',
  clientSecret: 'test-client-secret',
  authSecret: 'test-auth-secret-test-auth-secret',
  requiredAcr: 'loa2',
  controlDatabaseUrl: 'postgres://reader@127.0.0.1:5432/gremion_control',
  platformDatabaseUrl: null,
  executor: 'none',
  internalPushSecret: null,
}

function jwtToken(payload: object): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b({ alg: 'none' })}.${b(payload)}.sig`
}

type JwtCb = (p: { token: JWT; account?: unknown }) => Promise<JWT | null> | JWT | null
type SessionCb = (p: { session: object; token: JWT }) => Promise<object> | object

const callbacks = authConfig(config).callbacks as unknown as { jwt: JwtCb; session: SessionCb }

describe('authConfig: absolute session lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stamps the sign-in time when the code exchange returns an account', async () => {
    const account = {
      access_token: jwtToken({ iss: config.issuer, sub: 'u1', acr: 'loa2', realm_access: { roles: ['operator'] } }),
      id_token: jwtToken({ iss: config.issuer, sub: 'u1', email: 'ops@platform.example' }),
    }
    const t = await callbacks.jwt({ token: {}, account })
    expect(t).not.toBeNull()
    expect(t!.opsAuthAt).toBe(NOW)
    expect(t!.opsRoles).toEqual(['operator'])
  })

  it('a later read keeps the ORIGINAL sign-in time (a renewal never extends it)', async () => {
    const t = await callbacks.jwt({ token: { opsAuthAt: NOW - 600, opsIss: config.issuer } })
    expect(t!.opsAuthAt).toBe(NOW - 600)
  })

  // Once past the lifetime the token is REPLACED by a bare expiry marker: every
  // claim (issuer, roles, acr, subject) is gone, so nothing the session granted
  // survives, and the gate tells "expired" (GET: back to the ops realm; else
  // 403 and the cookie cleared) apart from a forged cookie. Returning null
  // instead would make Auth.js drop the session, and an active operator would
  // see "forged or stale" 403 on the next page (found on the running panel).
  const EXPIRED = { opsError: 'SessionExpired' }

  it('replaces a token older than the absolute lifetime with a bare expiry marker (no claim survives)', async () => {
    const old = { opsAuthAt: NOW - SESSION_ABSOLUTE_SECONDS - 1, opsIss: config.issuer, opsAcr: 'loa2', opsUid: 'u1', opsRoles: ['operator'], sub: 'u1' }
    expect(await callbacks.jwt({ token: old })).toEqual(EXPIRED)
    expect(await callbacks.jwt({ token: { opsAuthAt: NOW - SESSION_ABSOLUTE_SECONDS, opsIss: config.issuer } })).toMatchObject({ opsIss: config.issuer })
  })

  it('a token with no sign-in time, a malformed or a future one, or an earlier marker stays expired (fail closed)', async () => {
    expect(await callbacks.jwt({ token: { opsIss: config.issuer } })).toEqual(EXPIRED)
    expect(await callbacks.jwt({ token: { opsAuthAt: 'yesterday' as unknown as number } })).toEqual(EXPIRED)
    expect(await callbacks.jwt({ token: { opsAuthAt: NOW + 3600 } })).toEqual(EXPIRED)
    expect(await callbacks.jwt({ token: { ...EXPIRED } })).toEqual(EXPIRED)
  })

  it('the session callback hands the sign-in time to the gate, and an expiry marker as an error with no claims', async () => {
    const s = (await callbacks.session({ session: {}, token: { opsIss: config.issuer, opsAuthAt: NOW - 5 } })) as { claims: { authAt?: number } }
    expect(s.claims.authAt).toBe(NOW - 5)
    const e = (await callbacks.session({ session: {}, token: { ...EXPIRED } })) as { claims: Record<string, unknown> }
    expect(e.claims).toEqual({ error: 'SessionExpired', roles: [] })
  })

  it('the cookie maxAge is no longer than the absolute lifetime', () => {
    expect(authConfig(config).session?.maxAge).toBeLessThanOrEqual(SESSION_ABSOLUTE_SECONDS)
  })
})
