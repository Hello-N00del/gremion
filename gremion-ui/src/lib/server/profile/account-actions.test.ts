// Settings > Profil: three buttons start Keycloak application-initiated actions
// (kc_action) through the normal gremion-ui sign-in. The server decides every
// authorization parameter; the form supplies one allowlisted key and nothing else.
import { describe, expect, test, vi } from 'vitest'
import { isActionFailure, isRedirect } from '@sveltejs/kit'
import {
  ACCOUNT_ACTIONS,
  ACTION_COOKIE,
  RETURN_PATH,
  accountActionParams,
  createCapabilityCache,
  readAccountActionResult,
  recordAccountActionReturn,
  startAccountAction,
  type StartAccountActionDeps,
} from './account-actions'
import { Role } from '$lib/auth/types'

const member = { id: 'kc-uuid-1', email: 'a@example.org', name: 'A', roles: [Role.Member], groups: [], loa: 1, authTime: 0 }

class Jar {
  store = new Map<string, string>()
  set = vi.fn((name: string, value: string, _opts: Record<string, unknown>) => void this.store.set(name, value))
  get = (name: string) => this.store.get(name)
  delete = vi.fn((name: string, _opts?: Record<string, unknown>) => void this.store.delete(name))
}

function event(fields: Record<string, string>, user: unknown = member, jar = new Jar()) {
  return {
    jar,
    event: {
      request: new Request('https://pilot.test/settings?/accountAction', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'x=y', referer: 'https://pilot.test/settings/profil' },
        body: new URLSearchParams(fields),
      }),
      url: new URL('https://pilot.test/settings?/accountAction'),
      cookies: jar,
      locals: { user },
    },
  }
}

/** The form body the Auth.js server signIn would read from the event handed to it. */
async function signInForm(ev: { request: Request }): Promise<Record<string, string>> {
  return Object.fromEntries(await ev.request.clone().formData()) as Record<string, string>
}

function deps(over: Partial<StartAccountActionDeps> = {}) {
  const signIn = vi.fn(async (_ev: unknown) => {
    throw Object.assign(new Error('redirect'), { __redirect: true })
  })
  return {
    signIn,
    hasOtpCredential: vi.fn(async (_id: string) => true),
    emailActionAvailable: vi.fn(async () => true),
    ...over,
  } as unknown as StartAccountActionDeps & {
    signIn: typeof signIn
    hasOtpCredential: ReturnType<typeof vi.fn>
    emailActionAvailable: ReturnType<typeof vi.fn>
  }
}

async function run(p: Promise<unknown>): Promise<unknown> {
  try {
    return await p
  } catch (e) {
    return e
  }
}

describe('accountActionParams: the parameters Keycloak is sent', () => {
  test('a user WITH a one-time code is sent through a full fresh sign-in at loa2', () => {
    expect(accountActionParams('CONFIGURE_TOTP', true)).toEqual({ kc_action: 'CONFIGURE_TOTP', prompt: 'login', acr_values: 'loa2' })
    expect(accountActionParams('UPDATE_PASSWORD', true)).toEqual({ kc_action: 'UPDATE_PASSWORD', prompt: 'login', acr_values: 'loa2' })
    expect(accountActionParams('UPDATE_EMAIL', true)).toEqual({ kc_action: 'UPDATE_EMAIL', prompt: 'login', acr_values: 'loa2' })
  })

  test('a user WITHOUT one is not asked for loa2 (the realm would deny them); the password is still asked again', () => {
    expect(accountActionParams('CONFIGURE_TOTP', false)).toEqual({ kc_action: 'CONFIGURE_TOTP', prompt: 'login' })
  })

  test('never sends max_age, so no freshness window can reuse an older authentication', () => {
    expect(Object.keys(accountActionParams('UPDATE_PASSWORD', true))).not.toContain('max_age')
  })
})

describe('startAccountAction', () => {
  test('hands the Auth.js sign-in a keycloak request with the server-built parameters and the Profil return path', async () => {
    const d = deps()
    const { event: ev } = event({ action: 'totp' })
    const out = await run(startAccountAction(ev, d))
    expect(out).toMatchObject({ __redirect: true })
    expect(d.hasOtpCredential).toHaveBeenCalledWith('kc-uuid-1')
    const sent = d.signIn.mock.calls[0]![0] as { request: Request }
    expect(await signInForm(sent)).toEqual({
      providerId: 'keycloak',
      redirectTo: RETURN_PATH,
      'authorizationParams-kc_action': 'CONFIGURE_TOTP',
      'authorizationParams-prompt': 'login',
      'authorizationParams-acr_values': 'loa2',
    })
    expect(sent.request.method).toBe('POST')
    expect(sent.request.headers.get('content-type')).toContain('application/x-www-form-urlencoded')
  })

  test.each([
    ['password', 'UPDATE_PASSWORD'],
    ['totp', 'CONFIGURE_TOTP'],
    ['email', 'UPDATE_EMAIL'],
  ])('button %s starts %s', async (key, kc) => {
    const d = deps()
    await run(startAccountAction(event({ action: key }).event, d))
    const form = await signInForm(d.signIn.mock.calls[0]![0] as { request: Request })
    expect(form['authorizationParams-kc_action']).toBe(kc)
    expect(ACCOUNT_ACTIONS[key as keyof typeof ACCOUNT_ACTIONS]).toBe(kc)
  })

  test('nothing the client posts besides the allowlisted key reaches the authorization request', async () => {
    const d = deps()
    await run(
      startAccountAction(
        event({
          action: 'password',
          'authorizationParams-acr_values': 'loa1',
          'authorizationParams-prompt': 'none',
          'authorizationParams-max_age': '86400',
          'authorizationParams-kc_action': 'UPDATE_PROFILE',
          redirectTo: 'https://evil.example',
          providerId: 'other',
          kc_action: 'DELETE_ACCOUNT',
        }).event,
        d,
      ),
    )
    expect(await signInForm(d.signIn.mock.calls[0]![0] as { request: Request })).toEqual({
      providerId: 'keycloak',
      redirectTo: RETURN_PATH,
      'authorizationParams-kc_action': 'UPDATE_PASSWORD',
      'authorizationParams-prompt': 'login',
      'authorizationParams-acr_values': 'loa2',
    })
  })

  test.each([[''], ['UPDATE_PROFILE'], ['DELETE_ACCOUNT'], ['UPDATE_PASSWORD'], ['__proto__'], ['toString']])(
    'refuses the unknown action %j with 400',
    async (action) => {
      const d = deps()
      const out = await run(startAccountAction(event({ action }).event, d))
      expect(isActionFailure(out)).toBe(true)
      expect(out).toMatchObject({ status: 400 })
      expect(d.signIn).not.toHaveBeenCalled()
    },
  )

  test.each([
    ['no session user', null],
    ['an empty id', { ...member, id: '' }],
    ['no member role', { ...member, roles: [Role.Guest] }],
  ])('refuses %s', async (_l, user) => {
    const d = deps()
    const out = await run(startAccountAction(event({ action: 'password' }, user).event, d))
    expect(isActionFailure(out)).toBe(true)
    expect(d.signIn).not.toHaveBeenCalled()
    expect(d.hasOtpCredential).not.toHaveBeenCalled()
  })

  test('an unknown OTP state fails CLOSED: no sign-in is started', async () => {
    const d = deps({
      hasOtpCredential: vi.fn(async () => {
        throw new Error('kc down')
      }),
    })
    const out = await run(startAccountAction(event({ action: 'totp' }).event, d))
    expect(out).toMatchObject({ status: 503 })
    expect(d.signIn).not.toHaveBeenCalled()
  })

  test('the e-mail action is refused while the capability is off', async () => {
    const d = deps({ emailActionAvailable: vi.fn(async () => false) })
    const out = await run(startAccountAction(event({ action: 'email' }).event, d))
    expect(out).toMatchObject({ status: 400, data: { accountAction: { error: 'unavailable' } } })
    expect(d.signIn).not.toHaveBeenCalled()
  })

  test('remembers which action was started, for the return trip', async () => {
    const d = deps()
    const { event: ev, jar } = event({ action: 'password' })
    await run(startAccountAction(ev, d))
    expect(jar.set).toHaveBeenCalledWith(ACTION_COOKIE, 'UPDATE_PASSWORD', expect.objectContaining({ path: '/', httpOnly: true, sameSite: 'lax', secure: true }))
  })

  test('a sign-in that returns instead of redirecting is a failure, not a success', async () => {
    const d = deps({ signIn: vi.fn(async () => undefined) as never })
    const out = await run(startAccountAction(event({ action: 'password' }).event, d))
    expect(isActionFailure(out)).toBe(true)
    expect(isRedirect(out)).toBe(false)
  })
})

describe('the return trip (kc_action_status)', () => {
  const url = (status: string | null) =>
    new URL('https://pilot.test/auth/callback/keycloak?code=c&state=s' + (status === null ? '' : '&kc_action_status=' + encodeURIComponent(status)))

  test.each(['success', 'cancelled', 'error'])('records %s next to the pending action', (status) => {
    const jar = new Jar()
    jar.store.set(ACTION_COOKIE, 'CONFIGURE_TOTP')
    recordAccountActionReturn(url(status), jar)
    expect(jar.store.get(ACTION_COOKIE)).toBe('CONFIGURE_TOTP.' + status)
  })

  test('ignores an unknown status value and a return without a pending action', () => {
    const jar = new Jar()
    jar.store.set(ACTION_COOKIE, 'UPDATE_PASSWORD')
    recordAccountActionReturn(url('<script>'), jar)
    expect(jar.store.get(ACTION_COOKIE)).toBe('UPDATE_PASSWORD')
    const empty = new Jar()
    recordAccountActionReturn(url('success'), empty)
    expect(empty.set).not.toHaveBeenCalled()
  })

  test('a callback without kc_action_status changes nothing', () => {
    const jar = new Jar()
    jar.store.set(ACTION_COOKIE, 'UPDATE_PASSWORD')
    recordAccountActionReturn(url(null), jar)
    expect(jar.set).not.toHaveBeenCalled()
  })

  test('reading the result returns it once and clears the cookie', () => {
    const jar = new Jar()
    jar.store.set(ACTION_COOKIE, 'UPDATE_PASSWORD.cancelled')
    expect(readAccountActionResult(jar)).toEqual({ action: 'UPDATE_PASSWORD', status: 'cancelled' })
    expect(jar.delete).toHaveBeenCalledWith(ACTION_COOKIE, expect.objectContaining({ path: '/' }))
    expect(readAccountActionResult(jar)).toBeNull()
  })

  test('a pending action without a status is not a result and is left alone', () => {
    const jar = new Jar()
    jar.store.set(ACTION_COOKIE, 'UPDATE_PASSWORD')
    expect(readAccountActionResult(jar)).toBeNull()
    expect(jar.delete).not.toHaveBeenCalled()
  })

  test.each(['garbage', 'UPDATE_PROFILE.success', 'UPDATE_PASSWORD.pwned', '<b>x</b>.success'])('a forged cookie value %j yields nothing', (value) => {
    const jar = new Jar()
    jar.store.set(ACTION_COOKIE, value)
    expect(readAccountActionResult(jar)).toBeNull()
  })
})

describe('createCapabilityCache', () => {
  test('answers from the probe, caches it, defaults to false when the probe fails', async () => {
    let now = 0
    const cache = createCapabilityCache({ ttlMs: 1000, failureTtlMs: 100, now: () => now })
    const probe = vi.fn(async () => true)
    expect(await cache.get('t1', probe)).toBe(true)
    expect(await cache.get('t1', probe)).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
    now = 1500
    await cache.get('t1', probe)
    expect(probe).toHaveBeenCalledTimes(2)

    const bad = vi.fn(async () => {
      throw new Error('down')
    })
    expect(await cache.get('t2', bad)).toBe(false)
    expect(await cache.get('t2', bad)).toBe(false)
    expect(bad).toHaveBeenCalledTimes(1)
    now = 1700
    expect(await cache.get('t2', bad)).toBe(false)
    expect(bad).toHaveBeenCalledTimes(2)
  })

  test('tenants do not share an answer', async () => {
    const cache = createCapabilityCache({ ttlMs: 1000, failureTtlMs: 100 })
    expect(await cache.get('a', async () => true)).toBe(true)
    expect(await cache.get('b', async () => false)).toBe(false)
  })
})
