// gremion#22 finding 1 — unit coverage for tenantForwardFetch, the handleFetch
// that re-stamps the trusted tenant headers on same-origin internal
// sub-requests so the resolver (proxy-trust gate) doesn't 403/404 them.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let SECRET: string | null = 'internal-secret'
vi.mock('$lib/server/internal-fetch', () => ({
  readInternalPushSecret: () => SECRET,
  // resolve.ts also imports these two; stub them so the module loads.
  constantTimeEqual: (a: string, b: string) => a === b,
  readProxyTrustSecret: () => 'proxy-secret',
}))

import { tenantForwardFetch } from './resolve'

// Minimal event stub: only what tenantForwardFetch reads.
function makeEvent(forwardedHost: string | undefined, pageOrigin = 'https://stura.example.org') {
  const headers = new Headers()
  if (forwardedHost !== undefined) headers.set('x-forwarded-host', forwardedHost)
  return {
    url: new URL(`${pageOrigin}/members/committees/abc/protokolle`),
    request: new Request(`${pageOrigin}/members/committees/abc/protokolle`, { headers }),
  }
}

// Capture the request that actually gets dispatched.
function capture() {
  let sent: Request | null = null
  const fetch = vi.fn(async (req: Request) => {
    sent = req
    return new Response('ok')
  })
  return { fetch, get: () => sent }
}

beforeEach(() => {
  SECRET = 'internal-secret'
})

describe('tenantForwardFetch (P2.1c internal forwarded-host)', () => {
  it('stamps x-forwarded-host + x-internal-host-trust on a same-origin /api sub-request', async () => {
    const event = makeEvent('stura.example.org')
    const request = new Request('https://stura.example.org/api/protocols?committeeId=abc')
    const { fetch, get } = capture()
    await tenantForwardFetch({ event, request, fetch } as never)
    const sent = get()!
    expect(sent.headers.get('x-forwarded-host')).toBe('stura.example.org')
    expect(sent.headers.get('x-internal-host-trust')).toBe('internal-secret')
  })

  it('propagates the PARENT forwarded host verbatim (never the raw request host)', async () => {
    const event = makeEvent('musterstadt.example.org', 'https://musterstadt.example.org')
    const request = new Request('https://musterstadt.example.org/api/protocols/xyz')
    const { fetch, get } = capture()
    await tenantForwardFetch({ event, request, fetch } as never)
    expect(get()!.headers.get('x-forwarded-host')).toBe('musterstadt.example.org')
  })

  it('does NOT touch a cross-origin (leaf-service) request', async () => {
    const event = makeEvent('stura.example.org')
    const request = new Request('http://content-service:8080/posts', {
      headers: { authorization: 'Bearer leaf-token' },
    })
    const { fetch, get } = capture()
    await tenantForwardFetch({ event, request, fetch } as never)
    const sent = get()!
    expect(sent.headers.get('x-internal-host-trust')).toBeNull()
    expect(sent.headers.get('x-forwarded-host')).toBeNull()
    expect(sent.headers.get('authorization')).toBe('Bearer leaf-token') // untouched
    expect(sent.url).toBe('http://content-service:8080/posts')
  })

  it('is a no-op when there is no edge forwarded host (dev/CI)', async () => {
    const event = makeEvent(undefined)
    const request = new Request('https://stura.example.org/api/protocols')
    const { fetch, get } = capture()
    await tenantForwardFetch({ event, request, fetch } as never)
    expect(get()!.headers.get('x-internal-host-trust')).toBeNull()
  })

  it('is a no-op when INTERNAL_PUSH_SECRET is unset (fail-closed: never forge a header)', async () => {
    SECRET = null
    const event = makeEvent('stura.example.org')
    const request = new Request('https://stura.example.org/api/protocols')
    const { fetch, get } = capture()
    await tenantForwardFetch({ event, request, fetch } as never)
    expect(get()!.headers.get('x-internal-host-trust')).toBeNull()
    expect(get()!.headers.get('x-forwarded-host')).toBeNull()
  })
})
