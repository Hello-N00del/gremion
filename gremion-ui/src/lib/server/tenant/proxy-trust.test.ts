import { beforeEach, describe, expect, it, vi } from 'vitest'

// P2.1c T5 — executable proxy-trust gate. When TENANT_PROXY_SHARED_SECRET is
// set, the resolver MUST 403 a request that does not carry a constant-time
// matching `x-proxy-trust: <secret>` header (the Traefik-injected edge header)
// BEFORE any registry lookup. When the secret is unset the gate is a byte-
// identical no-op (enforcement arrives at S4 deploy when the operator sets the
// env + the Traefik label together). T4's internal-trust bypass (a valid
// `x-internal-host-trust`) ALSO satisfies the gate (an internalFetch hop never
// traverses the edge, so it cannot carry the edge header).
//
// Per S3 constraint 7 these per-tenant resolver tests steer the env via the
// internal-fetch mock; constantTimeEqual is the REAL implementation.

// TASK-041: the resolver selects by WHOLE host (resolveTenantByHost). An edge
// request that passes the gate is also held to the Q2 cross-check, so every
// edge case below sends the Host the router matched alongside x-forwarded-host.
const resolveTenantByHost = vi.fn()
const runWithTenant = vi.fn(async (_ctx: unknown, fn: () => unknown) => fn())

vi.mock('$lib/server/tenant/registry', () => ({
  resolveTenantByHost: (host: string) => resolveTenantByHost(host),
  getTenantStatusByHost: vi.fn(async () => null),
}))
vi.mock('$lib/server/tenant/host-mismatch-log', () => ({ logHostRejection: vi.fn() }))
vi.mock('$lib/server/tenant/context', () => ({
  runWithTenant: (ctx: unknown, fn: () => unknown) => runWithTenant(ctx, fn),
}))
// Readiness + rate-limit default to pass so the gate is the only variable here.
vi.mock('$lib/server/tenant/readiness', () => ({
  isFleetPopulated: () => true,
  getTenantReadiness: () => 'ready',
  triggerTenantMigrationRetry: vi.fn(),
}))
vi.mock('$lib/server/tenant/rate-limit', () => ({
  checkTenantRateLimit: () => ({ allowed: true }),
}))

const internalPushSecret = { value: 'internal-secret-32-bytes-of-padding!' as string | null }
const proxyTrustSecret = { value: null as string | null }
vi.mock('$lib/server/internal-fetch', async () => {
  const actual = await vi.importActual<typeof import('../internal-fetch')>(
    '$lib/server/internal-fetch',
  )
  return {
    constantTimeEqual: actual.constantTimeEqual,
    readInternalPushSecret: () => internalPushSecret.value,
    readProxyTrustSecret: () => proxyTrustSecret.value,
  }
})

const { tenantResolveHandle } = await import('./resolve')

function makeEvent(opts: {
  forwardedHost?: string
  proxyTrust?: string
  internalTrust?: string
  rawHost?: string
}) {
  const headers = new Headers()
  if (opts.forwardedHost !== undefined) headers.set('x-forwarded-host', opts.forwardedHost)
  // What Traefik forwards: the Host it matched, equal to x-forwarded-host.
  const host = 'rawHost' in opts ? opts.rawHost : opts.forwardedHost
  if (host !== undefined) headers.set('host', host)
  if (opts.proxyTrust !== undefined) headers.set('x-proxy-trust', opts.proxyTrust)
  if (opts.internalTrust !== undefined) headers.set('x-internal-host-trust', opts.internalTrust)
  const url = new URL('http://internal/dashboard')
  return { url, request: new Request(url, { headers }), locals: {} as Record<string, unknown>, params: {} }
}

const SECRET = 'proxy-secret-32-bytes-of-padding!!!!'

describe('tenantResolveHandle — proxy-trust gate (T5)', () => {
  beforeEach(() => {
    resolveTenantByHost.mockReset()
    resolveTenantByHost.mockResolvedValue({ id: 'tid-1', slug: 'acme' })
    runWithTenant.mockReset()
    runWithTenant.mockImplementation(async (_ctx: unknown, fn: () => unknown) => fn())
    internalPushSecret.value = 'internal-secret-32-bytes-of-padding!'
    proxyTrustSecret.value = null
  })

  // ── secret SET → enforced ─────────────────────────────────────────────────

  it('403s BEFORE any registry lookup when the secret is set and the x-proxy-trust header is ABSENT', async () => {
    proxyTrustSecret.value = SECRET
    const resolve = vi.fn(async () => new Response('ok'))
    const event = makeEvent({ forwardedHost: 'council.example' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(403)
    expect(resolveTenantByHost).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(runWithTenant).not.toHaveBeenCalled()
    expect(event.locals.tenant).toBeUndefined()
  })

  it('403s when the x-proxy-trust header MISMATCHES the secret', async () => {
    proxyTrustSecret.value = SECRET
    const resolve = vi.fn(async () => new Response('ok'))
    const event = makeEvent({ forwardedHost: 'council.example', proxyTrust: 'wrong-secret' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(403)
    expect(resolveTenantByHost).not.toHaveBeenCalled()
  })

  it('passes through when the x-proxy-trust header MATCHES the secret (constant-time)', async () => {
    proxyTrustSecret.value = SECRET
    const resolve = vi.fn(async () => new Response('ok', { status: 200 }))
    const event = makeEvent({ forwardedHost: 'council.example', proxyTrust: SECRET })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(200)
    expect(resolveTenantByHost).toHaveBeenCalledWith('council.example')
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('a valid x-internal-host-trust (T4 bypass) also satisfies the gate WITHOUT the edge header', async () => {
    proxyTrustSecret.value = SECRET
    const resolve = vi.fn(async () => new Response('ok', { status: 200 }))
    const event = makeEvent({
      forwardedHost: 'council.example',
      internalTrust: 'internal-secret-32-bytes-of-padding!',
    })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(200)
    expect(resolveTenantByHost).toHaveBeenCalledWith('council.example')
    expect(event.locals.tenantSelectionTrusted).toBe(true)
  })

  it('403s when neither the edge header nor a valid internal-trust is present', async () => {
    proxyTrustSecret.value = SECRET
    const resolve = vi.fn(async () => new Response('ok'))
    const event = makeEvent({ forwardedHost: 'council.example', internalTrust: 'wrong' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(403)
    expect(resolveTenantByHost).not.toHaveBeenCalled()
  })

  // ── secret UNSET → byte-identical no-op ───────────────────────────────────

  it('is a no-op when the secret is UNSET: resolves normally with no edge header', async () => {
    proxyTrustSecret.value = null
    const resolve = vi.fn(async () => new Response('ok', { status: 200 }))
    const event = makeEvent({ forwardedHost: 'council.example' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(200)
    expect(resolveTenantByHost).toHaveBeenCalledWith('council.example')
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('does not 403 an unrelated request when the secret is UNSET even with a stray x-proxy-trust header', async () => {
    proxyTrustSecret.value = null
    const resolve = vi.fn(async () => new Response('ok', { status: 200 }))
    const event = makeEvent({ forwardedHost: 'council.example', proxyTrust: 'whatever' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(200)
  })
})
