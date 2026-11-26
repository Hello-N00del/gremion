import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { REFRESH_GRACE_MS } from './refresh-grace'
import type { TenantContext } from '$lib/server/tenant/context'

const tenant = {
  id: 'tenant-a', slug: 'tenant-a', issuer: 'https://kc.example.org/realms/tenant-a',
  kcInternal: 'http://keycloak:8080/auth/realms/tenant-a',
  authExternalBase: 'https://kc.example.org/realms/tenant-a',
  authClientId: 'gremion-ui', authClientSecretRef: 'ui-a', config: {},
} as unknown as TenantContext

test('the grace is one minute', () => {
  expect(REFRESH_GRACE_MS).toBe(60_000)
})

// The session layer keeps an expired token for the grace and caps the back-off after a 429 at the same
// number. The grace is replaced here by another value: what the session layer does has to follow it.
beforeEach(() => {
  vi.resetModules()
  vi.doMock('$env/dynamic/private', () => ({ env: { AUTH_SECRET: 'test-secret' } }))
  vi.doMock('$lib/server/tenant/secrets', () => ({ resolveSecret: (ref: string) => `secret-for-${ref}` }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.doUnmock('$lib/auth/refresh-grace')
  vi.doUnmock('$env/dynamic/private')
  vi.doUnmock('$lib/server/tenant/secrets')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function rateLimited(graceMs: number, retryAfter: string): Promise<{ min: number; max: number; kept: boolean }> {
  vi.doMock('$lib/auth/refresh-grace', () => ({ REFRESH_GRACE_MS: graceMs }))
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    headers: new Headers({ 'Retry-After': retryAfter }), ok: false, status: 429, text: async () => '', json: async () => ({}),
  }))
  // Same module registry as auth.ts: the tenant context is read from the one it was run in.
  const { runWithTenant } = await import('$lib/server/tenant/context')
  const { __jwtCallbackForTests } = await import('../../auth')
  const token = { refreshToken: 'rt', accessToken: 'at', accessTokenExpires: Date.now() - 1000 }
  const before = Date.now()
  const out = (await runWithTenant(tenant, () => __jwtCallbackForTests({ token, account: null, profile: {} } as never))) as Record<string, unknown>
  const after = Date.now()
  // The wait the back-off asks for, as the least and the most it can be given when the clock ticked meanwhile.
  const retryAt = out.refreshRetryAt as number
  return { min: retryAt - after, max: retryAt - before, kept: out.accessToken === 'at' && out.error === undefined }
}

test.each([20_000, 90_000])('the back-off after a 429 is capped at the refresh grace (%i ms), whatever Retry-After asks for', async (graceMs) => {
  const { min, max, kept } = await rateLimited(graceMs, '3600')
  expect(kept).toBe(true)
  expect(min).toBeLessThanOrEqual(graceMs)
  expect(max).toBeGreaterThanOrEqual(graceMs)
  expect(max).toBeLessThan(graceMs + 2_000)
})

test('a Retry-After below the grace is honoured as it is', async () => {
  const { min, max } = await rateLimited(90_000, '12')
  expect(min).toBeLessThanOrEqual(12_000)
  expect(max).toBeGreaterThanOrEqual(12_000)
  expect(max).toBeLessThan(14_000)
})
