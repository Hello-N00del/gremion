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
