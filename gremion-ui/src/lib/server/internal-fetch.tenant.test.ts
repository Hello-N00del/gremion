// P2.1c blocker 3 (T4) — internalFetch tenant forwarded-host injection.
//
// internalFetch makes a FRESH server-to-server HTTP request that does NOT
// carry the inbound x-forwarded-host, so once the tenant resolver is
// sequence() element 0 those inner calls 404 (fail-closed) — ALS does not
// cross the HTTP boundary. The sanctioned fix, now implemented in
// resolve.ts's isInternalTrustRequest: when
// invoked INSIDE a runWithTenant(ctx, …) scope, internalFetch must re-inject
// the current tenant's forwarded host + a constant-time internal-trust secret
// so the receiving resolver re-establishes the SAME tenant. Outside any ALS
// context (boot-time callers) it must send NEITHER header — today's behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$env/dynamic/private', () => ({
  env: {
    INTERNAL_PUSH_SECRET: 'test-secret-32-bytes-of-padding-xxx',
    PUBLIC_BASE_URL: 'http://stura.test:3000',
    INTERNAL_BASE_URL: undefined,
  },
}))

import { internalFetch } from './internal-fetch'
import { runWithTenant } from './tenant/context'
import type { TenantContext } from './tenant/context'

// Minimal stand-in TenantContext — internalFetch only reads `.slug`.
function tenant(slug: string): TenantContext {
  return { slug } as unknown as TenantContext
}

describe('internalFetch — tenant forwarded-host injection (P2.1c T4)', () => {
  const originalFetch = globalThis.fetch
  let lastCall: { url: string; init: RequestInit } | null = null

  beforeEach(() => {
    lastCall = null
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      lastCall = { url: String(input), init: init ?? {} }
      return new Response('ok', { status: 200 })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('inside runWithTenant(ctxA) sends x-forwarded-host=<slugA>.<apexDomain> + x-internal-host-trust=<secret>', async () => {
    await runWithTenant(tenant('tenant-a'), () =>
      internalFetch('/api/calendar/automations/minutes', { method: 'POST', body: '{}' }),
    )
    expect(lastCall).not.toBeNull()
    const headers = lastCall!.init.headers as Record<string, string>
    // apexDomain derives from the PUBLIC_BASE_URL host (stura.test) — slug prepended.
    expect(headers['x-forwarded-host']).toBe('tenant-a.stura.test')
    expect(headers['x-internal-host-trust']).toBe('test-secret-32-bytes-of-padding-xxx')
    // The Bearer auth path is unchanged.
    expect(headers.Authorization).toBe('Bearer test-secret-32-bytes-of-padding-xxx')
  })

  it('uses the CURRENT tenant slug (different scope ⇒ different forwarded host)', async () => {
    await runWithTenant(tenant('t2'), () => internalFetch('/api/news/abc', { method: 'GET' }))
    const headers = lastCall!.init.headers as Record<string, string>
    expect(headers['x-forwarded-host']).toBe('t2.stura.test')
  })

  it('outside any ALS context sends NEITHER tenant header (boot-time callers unchanged)', async () => {
    await internalFetch('/api/calendar/automations/minutes', { method: 'POST', body: '{}' })
    const headers = lastCall!.init.headers as Record<string, string>
    expect(headers['x-forwarded-host']).toBeUndefined()
    expect(headers['x-internal-host-trust']).toBeUndefined()
    // Bearer auth still present — only the tenant headers are scope-gated.
    expect(headers.Authorization).toBe('Bearer test-secret-32-bytes-of-padding-xxx')
  })

  it('does not let a caller-supplied header override the injected tenant host', async () => {
    await runWithTenant(tenant('tenant-a'), () =>
      internalFetch('/api/news/abc', {
        method: 'GET',
        headers: { 'x-forwarded-host': 'evil.example.org', 'x-internal-host-trust': 'forged' },
      }),
    )
    const headers = lastCall!.init.headers as Record<string, string>
    expect(headers['x-forwarded-host']).toBe('tenant-a.stura.test')
    expect(headers['x-internal-host-trust']).toBe('test-secret-32-bytes-of-padding-xxx')
  })
})
