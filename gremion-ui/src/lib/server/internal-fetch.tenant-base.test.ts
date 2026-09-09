// FIX4 (P2.1c) — INTERNAL_BASE_URL bypasses the apex forwarded-host middleware.
//
// The apex router (docker-compose.prod.yml gremion-ui-apex, priority 20) prepends
// the gremion-ui-apexhost middleware, which UNCONDITIONALLY sets
// `X-Forwarded-Host: default.${DOMAIN}`. If internalFetch's inner hop targets the
// public apex (the PUBLIC_BASE_URL fallback), that middleware OVERWRITES the
// `<slug>.<apex>` value T4 stamps -> the element-0 resolver reads `default` ->
// the server-to-server call executes against the DEFAULT tenant's data plane
// (cross-tenant read+write, fail-OPEN because x-internal-host-trust survives).
//
// FIX: set INTERNAL_BASE_URL to an in-container/in-cluster origin
// (`http://gremion-ui:3000`) that reaches gremion-ui WITHOUT traversing the apex
// router. Then the inner hop never hits Traefik/the apexhost middleware, so the
// stamped `x-forwarded-host` survives and the resolver re-selects the ORIGINAL
// tenant. This file pins that behavior: with INTERNAL_BASE_URL set to a non-apex
// origin, (1) the inner fetch targets that origin (NOT the apex), and (2) the
// RECEIVED x-forwarded-host equals the SENT `<slug>.<apex>`, which the REAL
// element-0 selector (extractLeftmostLabel) resolves back to the ORIGINAL slug
// (not `default`).
//
// NOTE: a separate file from internal-fetch.tenant.test.ts is required because
// vi.mock('$env/dynamic/private') is module-hoisted — that file pins the
// PUBLIC_BASE_URL fallback (INTERNAL_BASE_URL: undefined) and must keep doing so.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// INTERNAL_BASE_URL = the in-container origin; PUBLIC_BASE_URL = the public apex.
// The two MUST differ for the bypass to be meaningful (the whole point of the
// fix is that the inner hop does NOT use the apex origin).
vi.mock('$env/dynamic/private', () => ({
  env: {
    INTERNAL_PUSH_SECRET: 'test-secret-32-bytes-of-padding-xxx',
    PUBLIC_BASE_URL: 'https://stura.test',
    INTERNAL_BASE_URL: 'http://gremion-ui:3000',
  },
}))

import { internalFetch } from './internal-fetch'
import { runWithTenant } from './tenant/context'
import type { TenantContext } from './tenant/context'
// The REAL element-0 tenant selector — no mocks. This is what resolve.ts runs on
// the inbound x-forwarded-host as sequence() element 0.
import { extractLeftmostLabel } from './tenant/resolve'

function tenant(slug: string): TenantContext {
  return { slug } as unknown as TenantContext
}

describe('internalFetch + INTERNAL_BASE_URL — bypasses the apex forwarded-host middleware (FIX4)', () => {
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

  it('targets the in-container origin (NOT the public apex) so the inner hop never hits the apex router', async () => {
    await runWithTenant(tenant('t2'), () =>
      internalFetch('/api/news/abc', { method: 'GET' }),
    )
    expect(lastCall).not.toBeNull()
    // The inner request goes to gremion-ui:3000 directly — it does NOT traverse
    // Traefik, so the apex router (Host(`${DOMAIN}`), priority 20) + its
    // gremion-ui-apexhost middleware never run and never overwrite x-forwarded-host.
    expect(lastCall!.url).toBe('http://gremion-ui:3000/api/news/abc')
    expect(lastCall!.url).not.toContain('stura.test') // NOT the public apex
  })

  it('the SENT x-forwarded-host survives and the REAL resolver re-selects the ORIGINAL tenant (not default)', async () => {
    await runWithTenant(tenant('t2'), () =>
      internalFetch('/api/news/abc', { method: 'GET' }),
    )
    const headers = lastCall!.init.headers as Record<string, string>
    // T4 stamps the current tenant's 3-label host. Because the hop bypasses the
    // apexhost middleware, this is exactly what the receiver's element-0 resolver
    // observes — the value is NOT overwritten to `default.<apex>`.
    const received = headers['x-forwarded-host']
    expect(received).toBe('t2.stura.test')
    // Feed the RECEIVED header into the REAL element-0 selector (resolve.ts):
    // it re-selects the ORIGINAL tenant slug, NOT `default`.
    expect(extractLeftmostLabel(received)).toBe('t2')
    expect(extractLeftmostLabel(received)).not.toBe('default')
    // The internal-trust secret rides along (it is NOT stripped by any apex
    // middleware on this path), so isProxyTrusted still authorizes the hop.
    expect(headers['x-internal-host-trust']).toBe('test-secret-32-bytes-of-padding-xxx')
  })

  it('CONTRAST: had the hop used the apex origin, the apexhost middleware would force `default` — that is the bug this fixes', () => {
    // Documents the defeated failure mode. The apexhost middleware
    // (docker-compose.prod.yml) sets X-Forwarded-Host=default.${DOMAIN} on the
    // apex router; the resolver would then read `default` and execute against the
    // DEFAULT tenant. INTERNAL_BASE_URL prevents the hop from ever reaching it.
    expect(extractLeftmostLabel('default.stura.test')).toBe('default')
  })
})
