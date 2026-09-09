// P2.2-auth A3 (design §3.5(e), D-VOCAB): the decode call sites in src/auth.ts
// thread the CURRENT tenant's role vocabulary into safeDecodeAccessToken. The
// decode stays extraction-only (it FEEDS the filters, it is not one), so a
// narrowed vocabulary must NOT change behavior here — only the threading is
// asserted. Per the standing rule, per-tenant cases use EXPLICIT runWithTenant
// (never a harness enterWith default); the no-context case pins today's
// default path byte-identical (the existing auth.factory.test.ts environment).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Role } from '$lib/auth/types'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'
import { safeDecodeAccessToken } from '$lib/auth/decode'

const envMock: Record<string, string> = {}
vi.mock('$env/dynamic/private', () => ({ env: envMock }))
vi.mock('$lib/server/tenant/secrets', () => ({ resolveSecret: (ref: string) => `secret-for-${ref}` }))
// Spy-wrap the REAL decode module: calls execute the real implementation while
// the spy records the vocabulary argument the auth callbacks thread through.
vi.mock('$lib/auth/decode', { spy: true })

/** Unsigned, structurally-valid JWT (decodeJwt never verifies signatures). */
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64url')
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...payload,
  })}.signature-not-verified`
}

/**
 * Minimal TenantContext slice the jwt callback consumes: config.roles for the
 * vocabulary seam, plus the refresh-path realm fields. Synthetic — never the
 * harness default tenant.
 */
function tenantWith(roles?: string[]): TenantContext {
  return {
    id: 't-vocab',
    slug: 't-vocab',
    issuer: 'https://kc.example.org/realms/t-vocab',
    kcInternal: 'http://keycloak:8080/auth/realms/t-vocab',
    authExternalBase: 'https://kc.example.org/realms/t-vocab',
    authClientId: 'gremion-ui',
    authClientSecretRef: 'ui-t-vocab',
    config: roles !== undefined ? { roles } : {},
  } as unknown as TenantContext
}

const futureExp = (): number => Math.floor(Date.now() / 1000) + 300

describe('P2.2-auth A3 — auth.ts threads the tenant vocabulary into safeDecodeAccessToken', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    envMock.AUTH_SECRET = 'test-secret'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('first-login: decode receives the tenant-config vocabulary (explicit runWithTenant)', async () => {
    const access = makeJwt({ realm_access: { roles: ['member'] }, sub: 'u1', groups: [] })
    const { __jwtCallbackForTests } = await import('./auth')
    await runWithTenant(tenantWith(['guest', 'buergermeister']), () =>
      __jwtCallbackForTests({
        token: {},
        account: { access_token: access, expires_at: futureExp() },
        profile: {},
      } as never),
    )
    expect(safeDecodeAccessToken).toHaveBeenCalledWith(access, ['guest', 'buergermeister'])
  })

  it('first-login: a tenant WITHOUT a config.roles override threads the default Role-enum vocabulary', async () => {
    const access = makeJwt({ realm_access: { roles: ['member'] }, sub: 'u1', groups: [] })
    const { __jwtCallbackForTests } = await import('./auth')
    await runWithTenant(tenantWith(undefined), () =>
      __jwtCallbackForTests({
        token: {},
        account: { access_token: access, expires_at: futureExp() },
        profile: {},
      } as never),
    )
    expect(safeDecodeAccessToken).toHaveBeenCalledWith(access, Object.values(Role))
  })

  it('first-login: the id-token decode threads the SAME vocabulary', async () => {
    const access = makeJwt({ realm_access: { roles: ['member'] }, sub: 'u1', groups: [] })
    const idTok = makeJwt({ sub: 'u1', acr: '1' })
    const { __jwtCallbackForTests } = await import('./auth')
    await runWithTenant(tenantWith(['guest', 'buergermeister']), () =>
      __jwtCallbackForTests({
        token: {},
        account: { access_token: access, id_token: idTok, expires_at: futureExp() },
        profile: {},
      } as never),
    )
    expect(safeDecodeAccessToken).toHaveBeenCalledWith(access, ['guest', 'buergermeister'])
    expect(safeDecodeAccessToken).toHaveBeenCalledWith(idTok, ['guest', 'buergermeister'])
  })

  it('no tenant context (existing unit-harness path): no vocabulary threaded; behavior byte-identical', async () => {
    const access = makeJwt({ realm_access: { roles: ['member', 'unknown-role'] }, sub: 'u1', groups: [] })
    const { __jwtCallbackForTests } = await import('./auth')
    const token = await __jwtCallbackForTests({
      token: {},
      account: { access_token: access, expires_at: futureExp() },
      profile: {},
    } as never)
    expect(safeDecodeAccessToken).toHaveBeenCalledWith(access, undefined)
    // Default-path pin: roles filtering is unchanged by A3 (decode is not a filter).
    expect((token as { roles?: Role[] }).roles).toEqual([Role.Member])
  })

  // P2.2-auth A2 (gate repair): the FILTER site consumes the threaded
  // vocabulary — a narrowed tenant vocabulary drops a role the default keeps.
  it('A2: a narrowed tenant vocabulary drops a role the default would keep (explicit runWithTenant)', async () => {
    const access = makeJwt({ realm_access: { roles: ['member', 'guest'] }, sub: 'u1', groups: [] })
    const { __jwtCallbackForTests } = await import('./auth')
    const token = await runWithTenant(tenantWith(['guest']), () =>
      __jwtCallbackForTests({
        token: {},
        account: { access_token: access, expires_at: futureExp() },
        profile: {},
      } as never),
    )
    // 'member' is in the default Role enum but NOT in this tenant's vocabulary.
    expect((token as { roles?: Role[] }).roles).toEqual([Role.Guest])
  })

  it('A2: the default tenant (no config.roles) filters exactly as before', async () => {
    const access = makeJwt({ realm_access: { roles: ['member', 'unknown-role'] }, sub: 'u1', groups: [] })
    const { __jwtCallbackForTests } = await import('./auth')
    const token = await runWithTenant(tenantWith(undefined), () =>
      __jwtCallbackForTests({
        token: {},
        account: { access_token: access, expires_at: futureExp() },
        profile: {},
      } as never),
    )
    expect((token as { roles?: Role[] }).roles).toEqual([Role.Member])
  })

  it('refresh path: the refreshed access token is decoded with the tenant vocabulary', async () => {
    const newAccess = makeJwt({ realm_access: { roles: ['member'] }, sub: 'u1', groups: [] })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: newAccess, expires_in: 300 }),
      }),
    )
    const { __jwtCallbackForTests } = await import('./auth')
    const out = await runWithTenant(tenantWith(['guest', 'buergermeister']), () =>
      __jwtCallbackForTests({
        token: { accessTokenExpires: 0, refreshToken: 'rt' },
        account: null,
        profile: {},
      } as never),
    )
    expect(safeDecodeAccessToken).toHaveBeenCalledWith(newAccess, ['guest', 'buergermeister'])
    expect((out as { error?: string }).error).toBeUndefined()
  })
})
