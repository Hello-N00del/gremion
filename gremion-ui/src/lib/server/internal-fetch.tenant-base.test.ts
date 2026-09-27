// FIX4 (P2.1c) — INTERNAL_BASE_URL keeps the inner hop off the edge.
// Ported from StuRaOS (Tenancy D1 stage §1.5) by TASK-041 (L3-08).
//
// Original premise: the apex router (docker-compose.prod.yml gremion-ui-apex)
// prepended the gremion-ui-apexhost middleware, which UNCONDITIONALLY set
// `X-Forwarded-Host: default.${DOMAIN}`. If internalFetch's inner hop targeted
// the public apex (the PUBLIC_BASE_URL fallback), that middleware OVERWROTE the
// host T4 stamps → the element-0 resolver read `default` → the server-to-server
// call executed against the DEFAULT tenant's data plane. Cross-tenant read+write,
// fail-OPEN, because x-internal-host-trust survived the rewrite.
//
// FIX: set INTERNAL_BASE_URL to an in-container/in-cluster origin
// (`http://gremion-ui:3000`) that reaches gremion-ui WITHOUT traversing Traefik.
// The stamped `x-forwarded-host` then arrives unmodified and the resolver
// re-selects the ORIGINAL tenant.
//
// TENANCY D1 (§1.3/§1.5) — the premise, restated for the current model. §1.3
// DELETES the apexhost middleware outright, so the specific rewrite above is
// gone from the edge. This file is still load-bearing, for a reason that
// outlives that middleware: ANY hop that traverses the edge is subject to
// whatever the edge chooses to say about `x-forwarded-host`, and that header is
// now the ENTIRE tenant selector — there is no in-app re-derivation left to
// disagree with it. Keeping the internal hop off the edge keeps the header the
// sender's statement rather than the proxy's.
//
// §1.5 also changes WHAT is stamped: the tenant's REGISTERED primary host from
// `ctx.primaryHost`, not `<slug>.<apex>`. That makes the property below strictly
// stronger. Under the old model the surviving value was a synthesised string
// whose only claim to correctness was that the receiver parsed it the same way;
// now it is a `tenant_domain` row, so "the value survived" and "the right tenant
// was selected" are the same statement.
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
// The REAL forwarded-host normaliser — no mocks. This is what resolve.ts runs
// on the inbound x-forwarded-host as sequence() element 0 before the
// tenant_domain lookup.
import { normaliseHost } from './tenant/host'

/** A tenant on its OWN apex — the D1 shape, and one no `<slug>.<apex>` string
 *  could ever have produced. */
function tenant(slug: string, primaryHost: string): TenantContext {
  return { slug, primaryHost } as unknown as TenantContext
}

const T2 = tenant('t2', 'zweite-stadt.example')

// typescript(no-base-to-string): RequestInfo includes Request, whose
// String() coercion falls back to Object.prototype.toString ('[object
// Request]'), not its .url. internalFetch never passes a Request today, but
// this keeps the recorded lastCall.url meaningful if it ever does.
function urlOf(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.href
  if (typeof input === 'string') return input
  return input.url
}

describe('internalFetch + INTERNAL_BASE_URL — keeps the inner hop off the edge (FIX4)', () => {
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

  it('targets the in-container origin (NOT the public apex) so the inner hop never reaches Traefik', async () => {
    await runWithTenant(T2, () => internalFetch('/api/news/abc', { method: 'GET' }))
    expect(lastCall).not.toBeNull()
    // The inner request goes to gremion-ui:3000 directly — it does NOT traverse
    // Traefik, so no edge router or middleware gets to restate x-forwarded-host.
    expect(lastCall!.url).toBe('http://gremion-ui:3000/api/news/abc')
    expect(lastCall!.url).not.toContain('stura.test') // NOT the public apex
  })

  it('the SENT x-forwarded-host survives and is the tenant’s OWN registered row', async () => {
    await runWithTenant(T2, () => internalFetch('/api/news/abc', { method: 'GET' }))
    const headers = lastCall!.init.headers as Record<string, string>
    const received = headers['x-forwarded-host']
    // T4 stamps the current tenant's REGISTERED host (D1 §1.5). Because the hop
    // bypasses the edge, this is exactly what the receiver's element-0 resolver
    // observes.
    expect(received).toBe('zweite-stadt.example')
    // Feed the RECEIVED header into the REAL normaliser (host.ts): it yields
    // t2's OWN tenant_domain lookup key — a different row from the default
    // tenant's host, and from anything derived from the deployment apex.
    expect(normaliseHost(received)).toBe('zweite-stadt.example')
    expect(normaliseHost(received)).not.toBe(normaliseHost('default.stura.test'))
    expect(normaliseHost(received)).not.toBe(normaliseHost('stura.test'))
    // Nothing apex-shaped reached the wire at all.
    expect(received).not.toContain('stura.test')
    // The internal-trust secret rides along (nothing on this path strips it), so
    // isProxyTrusted still authorizes the hop.
    expect(headers['x-internal-host-trust']).toBe('test-secret-32-bytes-of-padding-xxx')
  })

  it('CONTRAST: an edge-restated host would select a DIFFERENT tenant — that is what staying off the edge prevents', () => {
    // Documents the defeated failure mode. The apexhost middleware set
    // X-Forwarded-Host=default.${DOMAIN} on the apex router; the resolver would
    // then look up the DEFAULT tenant's row and execute against ITS data plane.
    // (§1.3 deletes that middleware; INTERNAL_BASE_URL independently keeps the
    // hop from ever meeting an edge that could do the same thing again.)
    expect(normaliseHost('default.stura.test')).toBe('default.stura.test')
    expect(normaliseHost('default.stura.test')).not.toBe(normaliseHost('zweite-stadt.example'))
  })
})
