// Long-lived-session defect: hooks.server.ts forces re-login when
// `session.error` is set ("Also force re-login when the session has a token
// refresh error"), but sessionCallback never copied token.error onto the
// session. The jwt callback marks a failed refresh (RefreshTokenExpired, ...)
// and the cookie keeps that stale token, so the guard saw `undefined` forever:
// pages kept rendering with a dead SSO session and every Nextcloud / Matrix
// call carried an expired bearer (502 instead of a clean re-login).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const envMock: Record<string, string> = {}
vi.mock('$env/dynamic/private', () => ({ env: envMock }))
vi.mock('$lib/server/tenant/secrets', () => ({ resolveSecret: (ref: string) => `secret-for-${ref}` }))

function sessionFor(token: Record<string, unknown>) {
  return import('./auth').then(({ __sessionCallbackForTests }) =>
    __sessionCallbackForTests({
      session: { user: {}, expires: '2099-01-01T00:00:00.000Z' },
      token,
    } as never) as unknown as Promise<{ error?: string }>,
  )
}

describe('sessionCallback surfaces a failed token refresh to the authGuard', () => {
  beforeEach(() => {
    envMock.AUTH_SECRET = 'test-secret'
  })

  it.each(['RefreshTokenExpired', 'RefreshTokenMissing', 'RefreshTokenFailed', 'TokenDecodeFailed'])(
    'copies token.error=%s onto session.error',
    async (error) => {
      const session = await sessionFor({ sub: 'u1', uid: 'u1', error })
      expect(session.error).toBe(error)
    },
  )

  it('leaves session.error undefined for a healthy token', async () => {
    const session = await sessionFor({ sub: 'u1', uid: 'u1' })
    expect(session.error).toBeUndefined()
  })
})
