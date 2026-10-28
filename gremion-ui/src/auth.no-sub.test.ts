// r33f review (TASK-033-a / TRD-147): the cookie path follows the Bearer rule. An ACCESS token
// without `sub` yields NO user id: token.uid stays undefined and nothing falls back to the
// ID-token / Auth.js token.sub -- the gremion-ui client's ID token carries a PAIRWISE sub that
// matches nothing in Nextcloud / org_unit_members / finance / matrix / audit, so an id taken from
// it would be a wrong actor. authGuard's empty-id check then refuses the session.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const envMock: Record<string, string> = {}
vi.mock('$env/dynamic/private', () => ({ env: envMock }))
vi.mock('$lib/server/tenant/secrets', () => ({ resolveSecret: (ref: string) => `secret-for-${ref}` }))

function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64url')
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...payload,
  })}.signature-not-verified`
}
const futureExp = (): number => Math.floor(Date.now() / 1000) + 300
const PAIRWISE = 'pairwise-id-token-sub'
const REAL = '0192f3e0-1a2b-7c3d-8e4f-0123456789ab'

async function login(accessClaims: Record<string, unknown>, idClaims: Record<string, unknown> = { sub: PAIRWISE }) {
  const { __jwtCallbackForTests } = await import('./auth')
  return (await __jwtCallbackForTests({
    token: { sub: PAIRWISE },
    account: { access_token: makeJwt(accessClaims), id_token: makeJwt(idClaims), expires_at: futureExp() },
    profile: idClaims,
  } as never)) as Record<string, unknown>
}

async function sessionFor(token: Record<string, unknown>) {
  const { __sessionCallbackForTests } = await import('./auth')
  return (await __sessionCallbackForTests({ session: { user: {}, expires: '2099-01-01T00:00:00.000Z' }, token } as never)) as unknown as { user: { id?: string } }
}

describe('cookie path: an access token without sub gives no user id (follows the Bearer rule)', () => {
  beforeEach(() => {
    envMock.AUTH_SECRET = 'test-secret'
  })
  afterEach(() => vi.unstubAllGlobals())

  it('first login: access token WITH sub -> token.uid is that sub (normal logins are unaffected)', async () => {
    const token = await login({ realm_access: { roles: ['member'] }, sub: REAL, groups: [] })
    expect(token.uid).toBe(REAL)
    expect((await sessionFor(token)).user.id).toBe(REAL)
  })

  it('first login: access token WITHOUT sub -> token.uid stays undefined, the pairwise ID-token sub is NOT adopted', async () => {
    const token = await login({ realm_access: { roles: ['member'] }, groups: [] })
    expect(token.uid).toBeUndefined()
    expect(token.error).toBeUndefined()
  })

  it('first login: no access token at all (profile fallback) -> no id from the profile / ID-token sub either', async () => {
    const { __jwtCallbackForTests } = await import('./auth')
    const token = (await __jwtCallbackForTests({
      token: { sub: PAIRWISE },
      account: { id_token: makeJwt({ sub: PAIRWISE }), expires_at: futureExp() },
      profile: { sub: PAIRWISE },
    } as never)) as Record<string, unknown>
    expect(token.uid).toBeUndefined()
  })

  it('refresh: the refreshed access token WITH sub keeps/sets uid; WITHOUT sub it does not fall back to token.sub or a stale uid', async () => {
    const { __jwtCallbackForTests } = await import('./auth')
    const refresh = async (access: string, prior: Record<string, unknown>) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: access, expires_in: 300 }) }))
      const { runWithTenant } = await import('$lib/server/tenant/context')
      return (await runWithTenant(
        { id: 't', slug: 't', issuer: 'https://kc.example.org/realms/t', kcInternal: 'http://keycloak:8080/auth/realms/t', authExternalBase: 'x', authClientId: 'gremion-ui', authClientSecretRef: 'ui-t', config: {} } as never,
        () => __jwtCallbackForTests({ token: { ...prior, accessTokenExpires: 0, refreshToken: 'rt' }, account: null, profile: {} } as never),
      )) as Record<string, unknown>
    }
    const withSub = await refresh(makeJwt({ realm_access: { roles: ['member'] }, sub: REAL, groups: [] }), { sub: PAIRWISE })
    expect(withSub.uid).toBe(REAL)
    const without = await refresh(makeJwt({ realm_access: { roles: ['member'] }, groups: [] }), { sub: PAIRWISE, uid: REAL })
    expect(without.uid).toBeUndefined()
  })

  it('session: no token.uid -> user.id is empty (authGuard refuses it), never token.sub', async () => {
    const s = await sessionFor({ sub: PAIRWISE, roles: [], groups: [] })
    expect(s.user.id ?? '').toBe('')
    expect(s.user.id).not.toBe(PAIRWISE)
  })

  it('session: token.uid present -> user.id is the uid (not the pairwise sub)', async () => {
    const s = await sessionFor({ sub: PAIRWISE, uid: REAL, roles: [], groups: [] })
    expect(s.user.id).toBe(REAL)
  })
})
