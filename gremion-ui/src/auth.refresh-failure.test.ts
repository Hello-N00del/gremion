// A failed token refresh used to be silent, and a Keycloak outage (network
// error / 5xx / 429) logged every user out. Transient failures keep the token
// for a 60 s grace window; a 4xx is final; every failure is logged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'

const envMock: Record<string, string> = {}
vi.mock('$env/dynamic/private', () => ({ env: envMock }))
vi.mock('$lib/server/tenant/secrets', () => ({ resolveSecret: (ref: string) => `secret-for-${ref}` }))

const tenant = {
  id: 'tenant-a', slug: 'tenant-a', issuer: 'https://kc.example.org/realms/tenant-a',
  kcInternal: 'http://keycloak:8080/auth/realms/tenant-a',
  authExternalBase: 'https://kc.example.org/realms/tenant-a',
  authClientId: 'gremion-ui', authClientSecretRef: 'ui-a', config: {},
} as unknown as TenantContext

async function run(token: Record<string, unknown>) {
  const { __jwtCallbackForTests } = await import('./auth')
  return (await runWithTenant(tenant, () =>
    __jwtCallbackForTests({ token, account: null, profile: {} } as never),
  )) as Record<string, unknown>
}
const res = (status: number, body: string, headers: Record<string, string> = {}) =>
  ({ headers: new Headers(headers), ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) })

describe('jwtCallback refresh failure handling', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    envMock.AUTH_SECRET = 'test-secret'
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => { vi.unstubAllGlobals(); warn.mockRestore() })

  const base = () => ({ refreshToken: 'SECRET-RT', accessToken: 'SECRET-AT' })

  it('4xx invalid_grant is final: RefreshTokenExpired, logged with status + oauth error + tenant, no secrets', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(400, '{"error":"invalid_grant","error_description":"Token is not active"}')))
    const out = await run({ ...base(), accessTokenExpires: Date.now() - 1000 })
    expect(out.error).toBe('RefreshTokenExpired')
    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0].join(' '))
    expect(line).toContain('400')
    expect(line).toContain('invalid_grant')
    expect(line).toContain('tenant-a')
    expect(line).not.toContain('SECRET')
    expect(line).not.toContain('secret-for')
  })

  it('4xx with a non-JSON body still logs and is final', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(401, '<html>nope</html>')))
    const out = await run({ ...base(), accessTokenExpires: Date.now() - 1000 })
    expect(out.error).toBe('RefreshTokenExpired')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0].join(' '))).toContain('401')
  })

  it('5xx within grace is transient: token kept, no error, logged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(503, '')))
    const t = { ...base(), accessTokenExpires: Date.now() - 10_000 }
    const out = await run(t)
    expect(out.error).toBeUndefined()
    expect(out.accessToken).toBe('SECRET-AT')
    expect(out.accessTokenExpires).toBe(t.accessTokenExpires)
    expect(String(warn.mock.calls[0].join(' '))).toContain('503')
  })

  it('network error within grace is transient: token kept, no error, logged with name/message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const out = await run({ ...base(), accessTokenExpires: Date.now() - 10_000 })
    expect(out.error).toBeUndefined()
    const line = String(warn.mock.calls[0].join(' '))
    expect(line).toContain('TypeError')
    expect(line).toContain('fetch failed')
    expect(line).toContain('tenant-a')
  })

  it('5xx past the 60 s grace surfaces RefreshTokenFailed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(502, '')))
    const out = await run({ ...base(), accessTokenExpires: Date.now() - 61_000 })
    expect(out.error).toBe('RefreshTokenFailed')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('network error past the grace surfaces RefreshTokenFailed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const out = await run({ ...base(), accessTokenExpires: Date.now() - 120_000 })
    expect(out.error).toBe('RefreshTokenFailed')
  })

  it('429 within grace is transient: token kept, no error, logged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(429, '{"error":"too_many_requests"}')))
    const out = await run({ ...base(), accessTokenExpires: Date.now() - 10_000 })
    expect(out.error).toBeUndefined()
    expect(out.accessToken).toBe('SECRET-AT')
    expect(String(warn.mock.calls[0].join(' '))).toContain('429')
  })

  it('429 with Retry-After records a back-off and the next call does not hit Keycloak', async () => {
    const f = vi.fn().mockResolvedValue(res(429, '', { 'Retry-After': '30' }))
    vi.stubGlobal('fetch', f)
    const first = await run({ ...base(), accessTokenExpires: Date.now() - 10_000 })
    expect(first.error).toBeUndefined()
    expect(first.refreshRetryAt as number).toBeGreaterThan(Date.now() + 25_000)
    await run(first)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('429 without Retry-After applies a default back-off (5-10 s)', async () => {
    const f = vi.fn().mockResolvedValue(res(429, ''))
    vi.stubGlobal('fetch', f)
    const first = await run({ ...base(), accessTokenExpires: Date.now() - 10_000 })
    expect(first.error).toBeUndefined()
    const wait = (first.refreshRetryAt as number) - Date.now()
    expect(wait).toBeGreaterThan(4_000)
    expect(wait).toBeLessThanOrEqual(10_000)
    await run(first)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('429 with HTTP-date Retry-After honours the date', async () => {
    const date = new Date(Date.now() + 30_000).toUTCString()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(429, '', { 'Retry-After': date })))
    const first = await run({ ...base(), accessTokenExpires: Date.now() - 10_000 })
    const wait = (first.refreshRetryAt as number) - Date.now()
    expect(wait).toBeGreaterThan(25_000)
    expect(wait).toBeLessThanOrEqual(31_000)
  })

  it('429 with unparseable Retry-After falls back to the default back-off', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(429, '', { 'Retry-After': 'soon' })))
    const first = await run({ ...base(), accessTokenExpires: Date.now() - 10_000 })
    const wait = (first.refreshRetryAt as number) - Date.now()
    expect(wait).toBeGreaterThan(4_000)
    expect(wait).toBeLessThanOrEqual(10_000)
  })

  it('429 Retry-After is capped at 60 s (integer and HTTP-date)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(429, '', { 'Retry-After': '3600' })))
    const a = await run({ ...base(), accessTokenExpires: Date.now() - 10_000 })
    expect((a.refreshRetryAt as number) - Date.now()).toBeLessThanOrEqual(60_000)
    const date = new Date(Date.now() + 3_600_000).toUTCString()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(429, '', { 'Retry-After': date })))
    const b = await run({ ...base(), accessTokenExpires: Date.now() - 10_000 })
    expect((b.refreshRetryAt as number) - Date.now()).toBeLessThanOrEqual(60_000)
  })

  it('Retry-After of zero or a past date falls back to the default back-off', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(429, '', { 'Retry-After': '0' })))
    const a = await run({ ...base(), accessTokenExpires: Date.now() - 10_000 })
    const waitA = (a.refreshRetryAt as number) - Date.now()
    expect(waitA).toBeGreaterThan(4_000)
    expect(waitA).toBeLessThanOrEqual(10_000)
    const past = new Date(Date.now() - 30_000).toUTCString()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(429, '', { 'Retry-After': past })))
    const b = await run({ ...base(), accessTokenExpires: Date.now() - 10_000 })
    const waitB = (b.refreshRetryAt as number) - Date.now()
    expect(waitB).toBeGreaterThan(4_000)
    expect(waitB).toBeLessThanOrEqual(10_000)
  })

  it('429 past the 60 s grace surfaces RefreshTokenFailed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(429, '')))
    const out = await run({ ...base(), accessTokenExpires: Date.now() - 61_000 })
    expect(out.error).toBe('RefreshTokenFailed')
  })

  it('the logged oauth error is truncated to 64 chars', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(400, JSON.stringify({ error: 'x'.repeat(200) }))))
    await run({ ...base(), accessTokenExpires: Date.now() - 1000 })
    const line = String(warn.mock.calls[0].join(' '))
    expect(line).toContain('x'.repeat(64))
    expect(line).not.toContain('x'.repeat(65))
  })
})

// A Keycloak that accepts the connection and never answers used to hold every
// request whose access token had expired. The refresh fetch now carries an abort
// signal; a timeout within grace keeps the token and backs off, outside it ends
// as RefreshTokenFailed.
describe('jwtCallback refresh timeout', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    envMock.AUTH_SECRET = 'test-secret'
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); warn.mockRestore() })

  const base = () => ({ refreshToken: 'SECRET-RT', accessToken: 'SECRET-AT' })
  /** fetch that never answers and rejects with the abort reason, like undici. */
  const hangingFetch = () => vi.fn((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const sig = init?.signal
      if (!sig) return // no signal: hangs forever (the defect)
      const fail = () => reject(sig.reason ?? new DOMException('aborted', 'AbortError'))
      if (sig.aborted) fail()
      else sig.addEventListener('abort', fail, { once: true })
    }))
  const settle = async (p: Promise<Record<string, unknown>>) => {
    await vi.advanceTimersByTimeAsync(6_000)
    return p
  }

  it('the refresh fetch carries an AbortSignal', async () => {
    const f = vi.fn().mockResolvedValue(res(503, ''))
    vi.stubGlobal('fetch', f)
    await run({ ...base(), accessTokenExpires: Date.now() - 10_000 })
    const init = f.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('a hanging Keycloak does not hold the request: result within the timeout plus a margin', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    let done = false
    const p = run({ ...base(), accessTokenExpires: Date.now() - 10_000 }).then((r) => { done = true; return r })
    await vi.advanceTimersByTimeAsync(6_000)
    expect(done).toBe(true)
    await p
  })

  it('timeout within grace keeps the token, sets a future refreshRetryAt, logs a timeout line without secrets', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const out = await settle(run({ ...base(), accessTokenExpires: Date.now() - 10_000 }))
    expect(out.error).toBeUndefined()
    expect(out.accessToken).toBe('SECRET-AT')
    expect(out.refreshRetryAt as number).toBeGreaterThan(Date.now())
    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0].join(' '))
    expect(line).toContain('timeout')
    expect(line).toContain('tenant-a')
    expect(line).not.toContain('SECRET')
    expect(line).not.toContain('secret-for')
  })

  it('the back-off stays inside the grace window', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const t = { ...base(), accessTokenExpires: Date.now() - 10_000 }
    const out = await settle(run(t))
    // grace ends at accessTokenExpires + 60 s; the retry must not point past it
    expect(out.refreshRetryAt as number).toBeLessThanOrEqual((t.accessTokenExpires as number) + 60_000)
  })

  it('a second call before refreshRetryAt does not call fetch again', async () => {
    const f = hangingFetch()
    vi.stubGlobal('fetch', f)
    const first = await settle(run({ ...base(), accessTokenExpires: Date.now() - 10_000 }))
    expect(f).toHaveBeenCalledTimes(1)
    const second = await run(first)
    expect(second.error).toBeUndefined()
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('timeout outside the grace window surfaces RefreshTokenFailed', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const out = await settle(run({ ...base(), accessTokenExpires: Date.now() - 120_000 }))
    expect(out.error).toBe('RefreshTokenFailed')
    expect(String(warn.mock.calls[0].join(' '))).toContain('timeout')
  })

  it('a fast answer clears the timer: no stray abort after success', async () => {
    const f = vi.fn().mockResolvedValue(res(503, ''))
    vi.stubGlobal('fetch', f)
    await run({ ...base(), accessTokenExpires: Date.now() - 10_000 })
    const sig = (f.mock.calls[0][1] as RequestInit).signal as AbortSignal
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sig.aborted).toBe(false)
  })
})

// The grace window ends at accessTokenExpires + 60 s. That value is part of the
// session token itself and only a successful refresh writes a new one, so the end
// of the window is the same for every request that presents the token, however
// many arrive and however long Keycloak takes. Past it the session is refused.
describe('jwtCallback refresh grace is fixed by the session token', () => {
  const GRACE = 60_000
  let warn: ReturnType<typeof vi.spyOn>
  /** Start of every test; the access token expired one second before it. */
  let t0: number
  beforeEach(() => {
    envMock.AUTH_SECRET = 'test-secret'
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    t0 = Date.now()
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); warn.mockRestore() })

  /** A session token as the cookie holds it. Frozen: the callback must not write to it. */
  const cookie = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
    Object.freeze({ refreshToken: 'SECRET-RT', accessToken: 'SECRET-AT', accessTokenExpires: t0 - 1_000, ...extra })
  const hangingFetch = () => vi.fn((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const sig = init?.signal
      if (!sig) return
      const fail = () => reject(sig.reason ?? new DOMException('aborted', 'AbortError'))
      if (sig.aborted) fail()
      else sig.addEventListener('abort', fail, { once: true })
    }))
  /** One request at `ms` after the access token expired; waits out a refresh timeout. */
  const requestAt = async (ms: number, token: Record<string, unknown>) => {
    vi.setSystemTime(t0 - 1_000 + ms)
    const p = run(token)
    await vi.advanceTimersByTimeAsync(6_000)
    return p
  }
  const jwt = (payload: Record<string, unknown>) => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf-8').toString('base64url')
    return `${b64({ alg: 'none' })}.${b64(payload)}.sig`
  }
  const healthyFetch = () => vi.fn().mockResolvedValue(res(200, JSON.stringify({
    access_token: jwt({ sub: 'user-1', realm_access: { roles: [] }, groups: [] }),
    expires_in: 300,
    refresh_token: 'NEW-RT',
  })))

  it('requests during a stall are kept until expiry + grace and not one moment longer', async () => {
    const f = hangingFetch()
    vi.stubGlobal('fetch', f)
    const original = cookie()
    let current = original
    for (const ms of [1_000, 8_000, 15_000, 22_000, 30_000, 38_000, 45_000, 52_000]) {
      current = await requestAt(ms, current)
      expect(current.error, `request at ${ms} ms`).toBeUndefined()
      expect(current.accessToken).toBe('SECRET-AT')
      // the anchor never moves while the refresh fails
      expect(current.accessTokenExpires).toBe(original.accessTokenExpires)
    }
    // Keycloak was asked more than once, and every answer was a timeout
    expect(f.mock.calls.length).toBeGreaterThan(1)
    // one second past the window: an immediate 503 is refused, and so is a timeout
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(503, '')))
    expect((await requestAt(GRACE + 1_000, current)).error).toBe('RefreshTokenFailed')
    vi.stubGlobal('fetch', f)
    const late = await requestAt(GRACE + 1_000, current)
    expect(late.error).toBe('RefreshTokenFailed')
    expect(late.accessTokenExpires).toBe(original.accessTokenExpires)
  })

  it('the same token presented again after the grace window is refused every time', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const original = cookie()
    // while the window is open the token is kept, and a re-issued one carries a back-off
    const reissued = await requestAt(2_000, original)
    expect(reissued.error).toBeUndefined()
    expect(reissued.refreshRetryAt as number).toBeGreaterThan(Date.now())
    for (const ms of [GRACE + 1_000, GRACE + 20_000, GRACE + 45_000, 10 * GRACE, 60 * GRACE]) {
      expect((await requestAt(ms, original)).error, `original at ${ms} ms`).toBe('RefreshTokenFailed')
      expect((await requestAt(ms + 7_000, reissued)).error, `re-issued at ${ms} ms`).toBe('RefreshTokenFailed')
    }
  })

  it('a refused request leaves nothing behind that reopens the window', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    let current = cookie()
    for (const ms of [GRACE + 1_000, GRACE + 8_000, GRACE + 15_000, GRACE + 70_000]) {
      current = await requestAt(ms, current)
      expect(current.error, `request at ${ms} ms`).toBe('RefreshTokenFailed')
    }
  })

  it('a request that starts inside the window and times out after it is refused', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    // starts at expiry + 58 s, the timeout fires at expiry + 63 s
    const out = await requestAt(58_000, cookie())
    expect(out.error).toBe('RefreshTokenFailed')
  })

  it('a back-off never points past the end of the grace window', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const original = cookie()
    // the timeout fires at expiry + 55 s: 5 s of the window are left
    const out = await requestAt(50_000, original)
    expect(out.error).toBeUndefined()
    expect(out.refreshRetryAt as number).toBeLessThanOrEqual((original.accessTokenExpires as number) + GRACE)
  })

  it('a back-off recorded in the token does not skip the refresh or keep the session past grace', async () => {
    const stalled = hangingFetch()
    vi.stubGlobal('fetch', stalled)
    const far = cookie({ refreshRetryAt: t0 + 10 * GRACE })
    expect((await requestAt(GRACE + 1_000, far)).error).toBe('RefreshTokenFailed')
    expect(stalled).toHaveBeenCalledTimes(1)
    const unavailable = vi.fn().mockResolvedValue(res(503, ''))
    vi.stubGlobal('fetch', unavailable)
    expect((await requestAt(GRACE + 1_000, far)).error).toBe('RefreshTokenFailed')
    expect(unavailable).toHaveBeenCalledTimes(1)
    const limited = vi.fn().mockResolvedValue(res(429, '', { 'Retry-After': '30' }))
    vi.stubGlobal('fetch', limited)
    expect((await requestAt(GRACE + 1_000, far)).error).toBe('RefreshTokenFailed')
    expect(limited).toHaveBeenCalledTimes(1)
  })

  it('an accessTokenExpires that is not a finite number gets no grace', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    for (const bad of [undefined, null, Number.NaN, String(t0 - 120_000), { valueOf: () => t0 }]) {
      const out = await requestAt(2_000, cookie({ accessTokenExpires: bad }))
      expect(out.error, `accessTokenExpires=${JSON.stringify(bad)}`).toBe('RefreshTokenFailed')
    }
  })

  it('a token that already carries an error stays refused inside the window', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const first = await requestAt(2_000, cookie({ error: 'RefreshTokenExpired' }))
    expect(first.error).toBe('RefreshTokenExpired')
    // the back-off path returns it as it is
    expect((await requestAt(9_000, first)).error).toBe('RefreshTokenExpired')
  })

  it('an outage shorter than the grace window does not end the session', async () => {
    const stalled = hangingFetch()
    vi.stubGlobal('fetch', stalled)
    const original = cookie()
    let current = await requestAt(2_000, original)
    expect(current.error).toBeUndefined()
    // inside the back-off: kept without asking Keycloak again
    current = await requestAt(9_000, current)
    expect(current.error).toBeUndefined()
    expect(stalled).toHaveBeenCalledTimes(1)
    // Keycloak answers again 30 s after expiry: the session is refreshed
    const healthy = healthyFetch()
    vi.stubGlobal('fetch', healthy)
    vi.setSystemTime(t0 - 1_000 + 30_000)
    const out = await run(current)
    expect(healthy).toHaveBeenCalledTimes(1)
    expect(out.error).toBeUndefined()
    expect(out.accessToken).not.toBe('SECRET-AT')
    expect(out.refreshToken).toBe('NEW-RT')
    expect(out.uid).toBe('user-1')
    expect(out.accessTokenExpires).toBe(Date.now() + 300_000)
  })

  it('a session refused during a stall is refreshed again once Keycloak answers', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const refused = await requestAt(GRACE + 30_000, cookie())
    expect(refused.error).toBe('RefreshTokenFailed')
    vi.stubGlobal('fetch', healthyFetch())
    const out = await run(refused)
    expect(out.error).toBeUndefined()
    expect(out.refreshToken).toBe('NEW-RT')
  })

  it('the normal refresh path is unchanged: one call, a new token and a new expiry', async () => {
    const healthy = healthyFetch()
    vi.stubGlobal('fetch', healthy)
    const original = cookie({ idToken: 'OLD-ID', tokenIss: 'https://kc.example.org/realms/tenant-a', acr: '1' })
    const out = await run(original)
    expect(healthy).toHaveBeenCalledTimes(1)
    expect(String(healthy.mock.calls[0][0])).toBe('http://keycloak:8080/auth/realms/tenant-a/protocol/openid-connect/token')
    expect(out.error).toBeUndefined()
    expect(out.refreshToken).toBe('NEW-RT')
    expect(out.idToken).toBe('OLD-ID')
    expect(out.tokenIss).toBe('https://kc.example.org/realms/tenant-a')
    expect(out.acr).toBe('1')
    expect(out.uid).toBe('user-1')
    expect(out.accessTokenExpires).toBe(Date.now() + 300_000)
    // nothing was written to the token that was presented
    expect(original.accessToken).toBe('SECRET-AT')
  })

  it('a token that has not expired is returned as it is, without a refresh', async () => {
    const f = hangingFetch()
    vi.stubGlobal('fetch', f)
    const valid = cookie({ accessTokenExpires: t0 + 120_000 })
    expect(await run(valid)).toBe(valid)
    expect(f).not.toHaveBeenCalled()
  })
})
