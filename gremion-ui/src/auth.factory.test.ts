import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RequestEvent } from '@sveltejs/kit'

const envMock: Record<string, string> = {}
vi.mock('$env/dynamic/private', () => ({ env: envMock }))
vi.mock('$lib/server/tenant/secrets', () => ({ resolveSecret: (ref: string) => `secret-for-${ref}` }))

type TenantAuth = {
  id: string; realmName: string; issuer: string; kcInternal: string
  authExternalBase: string; authClientId: string; authClientSecretRef: string; audiences: string[]
}
function eventWith(tenant: TenantAuth): RequestEvent {
  return { locals: { tenant } } as unknown as RequestEvent
}
const tenantA: TenantAuth = {
  id: 'a', realmName: 'tenant-a', issuer: 'https://kc.example.org/realms/tenant-a',
  kcInternal: 'http://keycloak:8080/auth/realms/tenant-a', authExternalBase: 'https://kc.example.org/realms/tenant-a',
  authClientId: 'gremion-ui', authClientSecretRef: 'ui-a', audiences: ['gremion-ui'],
}

describe('buildAuthConfig(event) — per-tenant Auth.js config', () => {
  beforeEach(() => { envMock.AUTH_SECRET = 'test-secret' })

  it('builds a Keycloak provider bound to the tenant realm', async () => {
    const { buildAuthConfig } = await import('./auth')
    const cfg = await buildAuthConfig(eventWith(tenantA))
    expect(cfg.secret).toBe('test-secret')
    const provider = (cfg.providers as unknown as Array<Record<string, unknown>>)[0]
    const opts = (provider.options ?? provider) as Record<string, unknown>
    expect(opts.issuer).toBe('https://kc.example.org/realms/tenant-a')
    expect(opts.clientId).toBe('gremion-ui')
    expect(opts.clientSecret).toBe('secret-for-ui-a')
    expect(String(opts.authorization)).toContain('/realms/tenant-a/protocol/openid-connect/auth')
  })
  it('throws when AUTH_SECRET is unset (per-request, not import-time)', async () => {
    delete envMock.AUTH_SECRET
    const { buildAuthConfig } = await import('./auth')
    await expect(buildAuthConfig(eventWith(tenantA))).rejects.toThrow(/AUTH_SECRET/)
  })
  it('default tenant maps to today env values byte-identically (golden)', async () => {
    const dflt: TenantAuth = {
      id: 'default', realmName: 'sturaos', issuer: 'https://council.example/auth/realms/sturaos',
      kcInternal: 'http://keycloak:8080/auth/realms/sturaos', authExternalBase: 'https://council.example/auth/realms/sturaos',
      authClientId: 'gremion-ui', authClientSecretRef: 'ui-default', audiences: ['gremion-ui', 'gremion-mobile'],
    }
    const { buildAuthConfig } = await import('./auth')
    const cfg = await buildAuthConfig(eventWith(dflt))
    const p = (cfg.providers as unknown as Array<Record<string, unknown>>)[0]
    const opts = (p.options ?? p) as Record<string, unknown>
    expect(opts.issuer).toBe('https://council.example/auth/realms/sturaos')
    expect(String(opts.token)).toBe('http://keycloak:8080/auth/realms/sturaos/protocol/openid-connect/token')
  })
})

// CR2 end-to-end: drive the REAL jwt + session callbacks (NOT hand-injected) and
// prove the access-token iss flows token.tokenIss -> session.tokenIss. This is the
// test the Task-28 iss-match suite cannot provide (it injects tokenIss directly).
describe('CR2 — jwt+session callbacks capture the access-token issuer', () => {
  beforeEach(() => { envMock.AUTH_SECRET = 'test-secret' })

  // The jwt callback decodes the access token via jose.decodeJwt (no signature
  // verification), so an unsigned, structurally-valid token proves iss capture.
  // Real SignJWT trips jsdom's cross-realm Uint8Array guard, and this file MUST
  // run under jsdom because ./auth -> @auth/sveltekit -> @sveltejs/kit needs window.
  async function realTokens(iss: string) {
    const b64 = (obj: unknown): string =>
      Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64url')
    const header = b64({ alg: 'RS256', typ: 'JWT' })
    const payload = b64({
      realm_access: { roles: ['member'] }, sub: 'kc-uuid', groups: [], iss,
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
    })
    return `${header}.${payload}.signature-not-verified`
  }

  it('access-token branch: token.tokenIss = decoded.iss; session.tokenIss = token.tokenIss', async () => {
    const ISS = 'https://kc.example.org/realms/tenant-a'
    const access = await realTokens(ISS)
    const { __jwtCallbackForTests, __sessionCallbackForTests } = await import('./auth')
    const token = await __jwtCallbackForTests({
      token: {}, account: { access_token: access, expires_at: Math.floor(Date.now() / 1000) + 300 }, profile: {},
    } as never)
    expect((token as { tokenIss?: string }).tokenIss).toBe(ISS)
    const session = await __sessionCallbackForTests({ session: { user: {} }, token } as never)
    expect((session as { tokenIss?: string }).tokenIss).toBe(ISS)
  })

  it('id-token-fallback branch: token.tokenIss = profile.iss when there is no access token', async () => {
    const ISS = 'https://kc.example.org/realms/tenant-b'
    const { __jwtCallbackForTests } = await import('./auth')
    const token = await __jwtCallbackForTests({
      token: {}, account: { expires_at: Math.floor(Date.now() / 1000) + 300 }, profile: { iss: ISS, sub: 's' },
    } as never)
    expect((token as { tokenIss?: string }).tokenIss).toBe(ISS)
  })

  it('refresh branch preserves the prior tokenIss', async () => {
    const ISS = 'https://kc.example.org/realms/tenant-a'
    const { __jwtCallbackForTests } = await import('./auth')
    // a token already past expiry with no refresh token surfaces an error but keeps tokenIss
    const out = await __jwtCallbackForTests({
      token: { tokenIss: ISS, accessTokenExpires: 0 }, account: null, profile: {},
    } as never)
    expect((out as { tokenIss?: string }).tokenIss).toBe(ISS)
  })
})
