// The REAL Auth.js server signIn (src/auth.ts -> @auth/sveltekit), not a mock: the body
// that startAccountAction builds must come out as a Keycloak authorization request that
// carries kc_action, prompt and acr_values, with PKCE/state, and the callback URL that
// brings the user back to Settings > Profil. Everything else a client posts is dropped.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { isRedirect } from '@sveltejs/kit'
import { startAccountAction, RETURN_PATH } from './account-actions'
import { Role, type SessionUser } from '$lib/auth/types'

// Under jsdom the global ArrayBuffer is not the one Node's crypto hands back, so oauth4webapi's
// `input instanceof ArrayBuffer` misses the PKCE digest. Compare by tag for this file only.
const nativeHasInstance = Object.getOwnPropertyDescriptor(ArrayBuffer, Symbol.hasInstance)
beforeAll(() => {
  Object.defineProperty(ArrayBuffer, Symbol.hasInstance, {
    configurable: true,
    value: (v: unknown) => Object.prototype.toString.call(v) === '[object ArrayBuffer]',
  })
})
afterAll(() => {
  if (nativeHasInstance) Object.defineProperty(ArrayBuffer, Symbol.hasInstance, nativeHasInstance)
  else Reflect.deleteProperty(ArrayBuffer, Symbol.hasInstance)
})

const envMock: Record<string, string> = { AUTH_SECRET: 'test-secret' }
vi.mock('$env/dynamic/private', () => ({ env: envMock }))
vi.mock('$lib/server/tenant/secrets', () => ({ resolveSecret: (ref: string) => `secret-for-${ref}` }))

const tenant = {
  id: 'a',
  realmName: 'tenant-a',
  issuer: 'https://kc.example.org/auth/realms/tenant-a',
  kcInternal: 'http://keycloak:8080/auth/realms/tenant-a',
  authExternalBase: 'https://kc.example.org/auth/realms/tenant-a',
  authClientId: 'gremion-ui',
  authClientSecretRef: 'ui-a',
  audiences: ['gremion-ui'],
}
const member = { id: 'kc-uuid-1', email: 'a@example.org', name: 'A', roles: [Role.Member], groups: [], loa: 1, authTime: 0 } as unknown as SessionUser

async function run(fields: Record<string, string>, hasOtp: boolean) {
  const { signIn } = await import('../../../auth')
  const cookies = new Map<string, string>()
  const jar = {
    get: (n: string) => cookies.get(n),
    set: (n: string, v: string) => void cookies.set(n, v),
    delete: (n: string) => void cookies.delete(n),
  }
  const url = new URL('https://pilot.test/settings?/accountAction')
  const event = {
    request: new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', host: 'pilot.test' },
      body: new URLSearchParams(fields),
    }),
    url,
    cookies: jar,
    locals: { user: member, tenant },
  }
  let thrown: unknown
  try {
    await startAccountAction(event as never, {
      signIn: signIn as never,
      hasOtpCredential: async () => hasOtp,
      emailActionAvailable: async () => true,
    })
  } catch (e) {
    thrown = e
  }
  if (!isRedirect(thrown)) throw new Error("not a redirect: " + String((thrown as Error)?.stack ?? thrown).slice(0, 600))
  const redirect = thrown as { status: number; location: string }
  return { redirect, cookies, location: new URL(redirect.location) }
}

describe('startAccountAction through the real Auth.js signIn', () => {
  test('CONFIGURE_TOTP for a user with a one-time code: kc_action, prompt=login, acr_values=loa2, PKCE and state', async () => {
    const { redirect, location } = await run({ action: 'totp' }, true)
    expect(redirect.status).toBe(302)
    expect(`${location.origin}${location.pathname}`).toBe('https://kc.example.org/auth/realms/tenant-a/protocol/openid-connect/auth')
    const q = location.searchParams
    expect(q.get('kc_action')).toBe('CONFIGURE_TOTP')
    expect(q.get('prompt')).toBe('login')
    expect(q.get('acr_values')).toBe('loa2')
    expect(q.get('client_id')).toBe('gremion-ui')
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('code_challenge')).toBeTruthy()
    expect(q.get('state')).toBeTruthy()
    expect(q.get('max_age')).toBeNull()
  })

  test('UPDATE_PASSWORD for a user without a one-time code: no loa2, still a fresh login', async () => {
    const { location } = await run({ action: 'password' }, false)
    const q = location.searchParams
    expect(q.get('kc_action')).toBe('UPDATE_PASSWORD')
    expect(q.get('prompt')).toBe('login')
    expect(q.has('acr_values')).toBe(false)
  })

  test('the return trip lands on Settings > Profil: the callback URL cookie is the Profil path', async () => {
    const { cookies, location } = await run({ action: 'password' }, true)
    expect(location.searchParams.get('redirect_uri')).toBe('https://pilot.test/auth/callback/keycloak')
    const callbackCookie = [...cookies.entries()].find(([name]) => name.endsWith('callback-url'))
    expect(callbackCookie?.[1]).toBe(`https://pilot.test${RETURN_PATH}`)
  })

  test('parameters and redirect targets a client posts itself never reach Keycloak', async () => {
    const { redirect, cookies, location } = await run(
      {
        action: 'totp',
        'authorizationParams-prompt': 'none',
        'authorizationParams-acr_values': 'loa1',
        'authorizationParams-kc_action': 'delete_credential:x',
        'authorizationParams-max_age': '99999',
        redirectTo: 'https://evil.example/steal',
        providerId: 'credentials',
      },
      true,
    )
    const q = location.searchParams
    expect(q.get('prompt')).toBe('login')
    expect(q.get('acr_values')).toBe('loa2')
    expect(q.get('kc_action')).toBe('CONFIGURE_TOTP')
    expect(q.has('max_age')).toBe(false)
    expect(JSON.stringify([...cookies.entries()]) + redirect.location).not.toMatch(/evil\.example/)
  })
})
