// P2.1c blocker 3 (T4) — internalFetch tenant forwarded-host injection.
//
// internalFetch makes a FRESH server-to-server HTTP request that does NOT
// carry the inbound x-forwarded-host, so once the tenant resolver is
// sequence() element 0 those inner calls 404 (fail-closed) — ALS does not
// cross the HTTP boundary. The sanctioned fix (resolve.ts isInternalTrustRequest): when invoked
// INSIDE a runWithTenant(ctx, …) scope, internalFetch must re-inject the
// current tenant's forwarded host + a constant-time internal-trust secret so
// the receiving resolver re-establishes the SAME tenant. Outside any ALS
// context (boot-time callers) it must send NEITHER header — today's behavior.
//
// Tenancy D1 (§1.5) — WHICH host it injects has changed, and that is the whole
// point of this stage. It used to be `${ctx.slug}.${apexDomain}`, synthesised
// from PUBLIC_BASE_URL to match a resolver that read the leftmost label as the
// tenant slug. The resolver now looks the WHOLE host up in `tenant_domain`, so
// the injected value is the tenant's REGISTERED PRIMARY host (`ctx.primaryHost`)
// and PUBLIC_BASE_URL contributes nothing to it. This file pins the stamping
// half; the receiving half (the real normaliser on the received value) is
// pinned in internal-fetch.tenant-base.test.ts.
//
// Ported from StuRaOS (Tenancy D1 stage §1.5) by TASK-041 (L3-08).
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

// Minimal stand-in TenantContext — internalFetch reads only `.primaryHost`.
// The slug is carried too, and deliberately does NOT match the host: nothing
// may compose one from the other.
function tenant(slug: string, primaryHost: string | null): TenantContext {
  return { slug, primaryHost } as unknown as TenantContext
}

// typescript(no-base-to-string): RequestInfo includes Request, whose
// String() coercion falls back to Object.prototype.toString ('[object
// Request]'), not its .url. internalFetch never passes a Request today, but
// this keeps the recorded lastCall.url meaningful if it ever does.
function urlOf(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.href
  if (typeof input === 'string') return input
  return input.url
}

describe('internalFetch — tenant forwarded-host injection (P2.1c T4, D1 §1.5)', () => {
  const originalFetch = globalThis.fetch
  let lastCall: { url: string; init: RequestInit } | null = null

  beforeEach(() => {
    lastCall = null
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      lastCall = { url: urlOf(input), init: init ?? {} }
      return new Response('ok', { status: 200 })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('inside runWithTenant(ctx) sends the tenant’s REGISTERED host + x-internal-host-trust=<secret>', async () => {
    await runWithTenant(tenant('tenant-a', 'rat-musterstadt.de'), () =>
      internalFetch('/api/calendar/automations/minutes', { method: 'POST', body: '{}' }),
    )
    expect(lastCall).not.toBeNull()
    const headers = lastCall!.init.headers as Record<string, string>
    // Verbatim from the context — NOT `tenant-a.stura.test`, which is what the
    // deleted apex synthesis would have produced from PUBLIC_BASE_URL.
    expect(headers['x-forwarded-host']).toBe('rat-musterstadt.de')
    expect(headers['x-forwarded-host']).not.toContain('stura.test')
    expect(headers['x-internal-host-trust']).toBe('test-secret-32-bytes-of-padding-xxx')
    // The Bearer auth path is unchanged.
    expect(headers.Authorization).toBe('Bearer test-secret-32-bytes-of-padding-xxx')
  })

  it('uses the CURRENT tenant’s host (different scope ⇒ different forwarded host)', async () => {
    await runWithTenant(tenant('t2', 'zweite-stadt.example'), () =>
      internalFetch('/api/news/abc', { method: 'GET' }),
    )
    const headers = lastCall!.init.headers as Record<string, string>
    expect(headers['x-forwarded-host']).toBe('zweite-stadt.example')
  })

  it('normalises the stored host to the receiver’s lookup key (case, port, root dot)', async () => {
    await runWithTenant(tenant('t2', 'Rat-Musterstadt.DE.:8443'), () =>
      internalFetch('/api/news/abc', { method: 'GET' }),
    )
    const headers = lastCall!.init.headers as Record<string, string>
    expect(headers['x-forwarded-host']).toBe('rat-musterstadt.de')
  })

  it('a tenant with NO primary host sends NEITHER header (fail closed — no apex fallback)', async () => {
    await runWithTenant(tenant('unrouted', null), () =>
      internalFetch('/api/news/abc', { method: 'GET' }),
    )
    const headers = lastCall!.init.headers as Record<string, string>
    expect(headers['x-forwarded-host']).toBeUndefined()
    expect(headers['x-internal-host-trust']).toBeUndefined()
    // PUBLIC_BASE_URL is set — the point is that it is NOT consulted as a fallback.
    expect(headers.Authorization).toBe('Bearer test-secret-32-bytes-of-padding-xxx')
  })

  it('a malformed stored host is dropped, never sent raw', async () => {
    await runWithTenant(tenant('t', 'evil.com:80@rat-musterstadt.de'), () =>
      internalFetch('/api/news/abc', { method: 'GET' }),
    )
    const headers = lastCall!.init.headers as Record<string, string>
    expect(headers['x-forwarded-host']).toBeUndefined()
    expect(headers['x-internal-host-trust']).toBeUndefined()
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
    await runWithTenant(tenant('tenant-a', 'rat-musterstadt.de'), () =>
      internalFetch('/api/news/abc', {
        method: 'GET',
        headers: { 'x-forwarded-host': 'evil.example.org', 'x-internal-host-trust': 'forged' },
      }),
    )
    const headers = lastCall!.init.headers as Record<string, string>
    expect(headers['x-forwarded-host']).toBe('rat-musterstadt.de')
    expect(headers['x-internal-host-trust']).toBe('test-secret-32-bytes-of-padding-xxx')
  })

  it('a caller-supplied host does NOT survive when the tenant has none (no partial forge)', async () => {
    await runWithTenant(tenant('unrouted', null), () =>
      internalFetch('/api/news/abc', {
        method: 'GET',
        headers: { 'x-forwarded-host': 'evil.example.org' },
      }),
    )
    const headers = lastCall!.init.headers as Record<string, string>
    // The caller's value is left in place (internalFetch only ever OVERWRITES,
    // it does not delete) — but it travels WITHOUT the internal-trust secret, so
    // the receiver's proxy-trust gate refuses the hop instead of honouring it.
    expect(headers['x-internal-host-trust']).toBeUndefined()
  })
})
