import { describe, expect, it } from 'vitest'
import { extractLeftmostLabel } from './resolve'
import { SUSPENDED_PAGE_MARKER } from './suspended-page'

describe('extractLeftmostLabel', () => {
  it('extracts the leftmost label from a subdomain host', () => {
    expect(extractLeftmostLabel('stura.example.org')).toBe('stura')
    expect(extractLeftmostLabel('t2.example.org')).toBe('t2')
  })
  it('strips a :port before extracting', () => {
    expect(extractLeftmostLabel('stura.example.org:3000')).toBe('stura')
  })
  it('returns null for a bare apex (two labels)', () => {
    expect(extractLeftmostLabel('example.org')).toBeNull()
  })
  it('returns null for a single-label host', () => {
    expect(extractLeftmostLabel('localhost')).toBeNull()
    expect(extractLeftmostLabel('localhost:5173')).toBeNull()
  })
  it('returns null for empty / undefined input', () => {
    expect(extractLeftmostLabel('')).toBeNull()
    expect(extractLeftmostLabel(undefined)).toBeNull()
  })
  it('lowercases the label', () => {
    expect(extractLeftmostLabel('Stura.Example.Org')).toBe('stura')
  })

  // ── #256-2: forwarded-host parser hardening ────────────────────────────────
  // In an append-style proxy chain, duplicate X-Forwarded-Host headers join to
  // 'client-value, edge-value' — taking the FIRST (client-most) value would let
  // an attacker-supplied label win over the trusted hop. Ambiguous = reject.
  it('rejects a comma-joined multi-value header (fail closed)', () => {
    expect(extractLeftmostLabel('evil.a.b, tenant.example.org')).toBeNull()
    expect(extractLeftmostLabel('evil.a.b,tenant.example.org')).toBeNull()
  })
  it('rejects a whitespace-separated list', () => {
    expect(extractLeftmostLabel('evil.a.b tenant.example.org')).toBeNull()
  })
  it('strips exactly ONE trailing dot so an FQDN apex still has no tenant label', () => {
    // 'example.org.' is the 2-label apex in FQDN root form — without the strip
    // it splits into 3 labels and the 2LD 'example' is looked up as a slug.
    expect(extractLeftmostLabel('example.org.')).toBeNull()
  })
  it('extracts the label from an FQDN subdomain host (one trailing dot)', () => {
    expect(extractLeftmostLabel('tenant.example.org.')).toBe('tenant')
  })
  it('rejects empty labels anywhere in the name', () => {
    expect(extractLeftmostLabel('tenant..org')).toBeNull()
    expect(extractLeftmostLabel('.tenant.example.org')).toBeNull()
    // a SECOND trailing dot is not FQDN form — after stripping one dot the
    // final label is empty, which must reject rather than parse.
    expect(extractLeftmostLabel('tenant.example.org..')).toBeNull()
  })
})

import { beforeEach, vi } from 'vitest'

const resolveTenantBySlug = vi.fn()
const getTenantStatusBySlug = vi.fn()
const runWithTenant = vi.fn(async (_ctx: unknown, fn: () => unknown) => fn())

vi.mock('$lib/server/tenant/registry', () => ({
  resolveTenantBySlug: (slug: string) => resolveTenantBySlug(slug),
  // P2.1c (T6): status-only lookup consulted on the resolver's null path.
  getTenantStatusBySlug: (slug: string) => getTenantStatusBySlug(slug),
}))
// P2.1c (T6): the suspended page must NOT touch the tenant data plane. Spy on
// getPoolForTenant so the suspended-path test can assert no pool was acquired.
const getPoolForTenant = vi.fn((_t: unknown) => ({ __pool: true }) as never)
vi.mock('$lib/server/db/pool-registry', () => ({
  getPoolForTenant: (t: unknown) => getPoolForTenant(t),
  evictTenantPool: vi.fn(),
}))
vi.mock('$lib/server/tenant/context', () => ({
  runWithTenant: (ctx: unknown, fn: () => unknown) => runWithTenant(ctx, fn),
  // P2.1c (T19): the resolver's request-error path now logs via the tenant-tagged
  // tlog seam, which reads getTenantOrNull(). No context is active on that path
  // (resolution itself failed), so it returns null here.
  getTenantOrNull: () => null,
}))
// P2.1b T3 (D-READY): the per-tenant readiness gate is mocked here so each test
// steers the tenant's state directly; the REAL map + retry semantics are pinned
// in readiness.test.ts. Defaults = fleet populated + tenant ready, so the
// pre-T3 tests above/below keep their exact behavior.
const readinessState = { populated: true, state: 'ready' as 'ready' | 'failed' | 'pending' }
const triggerTenantMigrationRetry = vi.fn()
vi.mock('$lib/server/tenant/readiness', () => ({
  isFleetPopulated: () => readinessState.populated,
  getTenantReadiness: () => readinessState.state,
  triggerTenantMigrationRetry: (t: unknown) => triggerTenantMigrationRetry(t),
}))

// P2.1b T10 (§7.6 D-RATE): the per-tenant rate limiter is mocked here so each
// test steers the verdict directly; the REAL token-bucket semantics (default
// OFF, refill, isolation) are pinned in rate-limit.test.ts. Default = allowed,
// so every pre-T10 test above/below keeps its exact behavior (the limiter is
// default OFF in production too — tenant #1 byte-identical).
const rateLimitVerdict = {
  value: { allowed: true } as { allowed: true } | { allowed: false; retryAfterSec: number },
}
const checkTenantRateLimit = vi.fn((_tenantId: string) => rateLimitVerdict.value)
vi.mock('$lib/server/tenant/rate-limit', () => ({
  checkTenantRateLimit: (tenantId: string) => checkTenantRateLimit(tenantId),
}))

// P2.1c T4: the resolver's internal-trust bypass reuses internal-fetch's
// constant-time compare + the shared INTERNAL_PUSH_SECRET. The secret is
// steered via this mock so a test can flip it to null (= bypass disabled,
// fail closed); `constantTimeEqual` is the REAL implementation (its semantics
// are pinned in internal-fetch.test.ts).
const internalPushSecret = { value: 'test-secret-32-bytes-of-padding-xxx' as string | null }
vi.mock('$lib/server/internal-fetch', async () => {
  const actual = await vi.importActual<typeof import('../internal-fetch')>(
    '$lib/server/internal-fetch',
  )
  return {
    constantTimeEqual: actual.constantTimeEqual,
    readInternalPushSecret: () => internalPushSecret.value,
    // T5 proxy-trust secret: default null (gate is a no-op) so every test in
    // this file keeps its exact pre-T5 behavior; the gate itself is pinned in
    // proxy-trust.test.ts.
    readProxyTrustSecret: () => null,
  }
})

const { tenantResolveHandle, isInternalTrustRequest } = await import('./resolve')

function makeEvent(opts: {
  forwardedHost?: string
  rawHost?: string
  path?: string
  internalTrust?: string
}) {
  const headers = new Headers()
  if (opts.forwardedHost !== undefined) headers.set('x-forwarded-host', opts.forwardedHost)
  if (opts.rawHost !== undefined) headers.set('host', opts.rawHost)
  if (opts.internalTrust !== undefined) headers.set('x-internal-host-trust', opts.internalTrust)
  const url = new URL(`http://internal${opts.path ?? '/dashboard'}`)
  return { url, request: new Request(url, { headers }), locals: {} as Record<string, unknown>, params: {} }
}

describe('tenantResolveHandle', () => {
  beforeEach(() => {
    resolveTenantBySlug.mockReset()
    getTenantStatusBySlug.mockReset()
    getTenantStatusBySlug.mockResolvedValue(null)
    getPoolForTenant.mockClear()
    runWithTenant.mockReset()
    runWithTenant.mockImplementation(async (_ctx: unknown, fn: () => unknown) => fn())
    triggerTenantMigrationRetry.mockReset()
    readinessState.populated = true
    readinessState.state = 'ready'
    checkTenantRateLimit.mockClear()
    rateLimitVerdict.value = { allowed: true }
    internalPushSecret.value = 'test-secret-32-bytes-of-padding-xxx'
  })

  it('resolves the forwarded-host label -> TenantContext on locals and wraps downstream', async () => {
    const ctx = { id: 'tid-1', slug: 'stura' }
    resolveTenantBySlug.mockResolvedValue(ctx)
    const downstream = new Response('ok', { status: 200 })
    const resolve = vi.fn(async () => downstream)
    const event = makeEvent({ forwardedHost: 'stura.example.org' })
    const res = await tenantResolveHandle({ event: event as never, resolve } as never)
    expect(resolveTenantBySlug).toHaveBeenCalledWith('stura')
    expect(event.locals.tenant).toBe(ctx)
    expect(runWithTenant).toHaveBeenCalledTimes(1)
    expect(runWithTenant.mock.calls[0][0]).toBe(ctx)
    expect(resolve).toHaveBeenCalledWith(event)
    expect(res).toBe(downstream)
  })

  it('IGNORES the raw Host header and reads only x-forwarded-host', async () => {
    resolveTenantBySlug.mockResolvedValue({ id: 'tid-1', slug: 'stura' })
    const resolve = vi.fn(async () => new Response('ok'))
    const event = makeEvent({ forwardedHost: 'stura.example.org', rawHost: 'evil.example.org' })
    await tenantResolveHandle({ event: event as never, resolve } as never)
    expect(resolveTenantBySlug).toHaveBeenCalledWith('stura')
    expect(resolveTenantBySlug).not.toHaveBeenCalledWith('evil')
  })

  it('returns 404 for an unknown subdomain (registry returns null)', async () => {
    resolveTenantBySlug.mockResolvedValue(null)
    getTenantStatusBySlug.mockResolvedValue(null) // row absent
    const resolve = vi.fn(async () => new Response('ok'))
    const event = makeEvent({ forwardedHost: 'ghost.example.org' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(404)
    expect(resolve).not.toHaveBeenCalled()
    expect(runWithTenant).not.toHaveBeenCalled()
    expect(event.locals.tenant).toBeUndefined()
  })

  // ── P2.1c (T6): suspended-tenant 503 page vs deleting/deleted tombstone 404 ─
  // resolveTenantBySlug collapses non-active rows to null; the resolver consults
  // the status-only lookup on that path to serve a branded, data-plane-free 503
  // for a SUSPENDED tenant while keeping unknown / deleting / deleted as 404.

  it('returns a 503 branded page (no DB pool touched) for a SUSPENDED tenant', async () => {
    resolveTenantBySlug.mockResolvedValue(null) // non-active → null
    getTenantStatusBySlug.mockResolvedValue('suspended')
    const resolve = vi.fn(async () => new Response('ok'))
    const event = makeEvent({ forwardedHost: 'paused.example.org' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('3600')
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    const body = await res.text()
    expect(body).toContain(SUSPENDED_PAGE_MARKER) // the static page marker
    expect(body).not.toMatch(/StuRaOS|HS Harz|Hochschule Harz|stura\.hs-harz\.de/) // neutral
    expect(getTenantStatusBySlug).toHaveBeenCalledWith('paused')
    expect(getPoolForTenant).not.toHaveBeenCalled() // data plane untouched
    expect(resolve).not.toHaveBeenCalled()
    expect(runWithTenant).not.toHaveBeenCalled()
    expect(event.locals.tenant).toBeUndefined()
  })

  it('returns 404 (tombstone) for a DELETING tenant — never the suspended page', async () => {
    resolveTenantBySlug.mockResolvedValue(null)
    getTenantStatusBySlug.mockResolvedValue('deleting')
    const resolve = vi.fn(async () => new Response('ok'))
    const event = makeEvent({ forwardedHost: 'gone.example.org' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(404)
    expect(getPoolForTenant).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('returns 404 (tombstone) for a DELETED tenant — identifier-reuse defence (§7.8)', async () => {
    resolveTenantBySlug.mockResolvedValue(null)
    getTenantStatusBySlug.mockResolvedValue('deleted')
    const resolve = vi.fn(async () => new Response('ok'))
    const event = makeEvent({ forwardedHost: 'gone.example.org' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(404)
    expect(getPoolForTenant).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('an ACTIVE tenant never consults the status lookup (resolves normally, unchanged)', async () => {
    const ctx = { id: 'tid-1', slug: 'stura' }
    resolveTenantBySlug.mockResolvedValue(ctx)
    const resolve = vi.fn(async () => new Response('ok', { status: 200 }))
    const event = makeEvent({ forwardedHost: 'stura.example.org' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(200)
    expect(getTenantStatusBySlug).not.toHaveBeenCalled()
    expect(event.locals.tenant).toBe(ctx)
  })

  it('returns the registry 503 if the status lookup THROWS (control-DB failure)', async () => {
    resolveTenantBySlug.mockResolvedValue(null)
    getTenantStatusBySlug.mockRejectedValue(new Error('control DB connection refused'))
    const resolve = vi.fn(async () => new Response('ok'))
    const event = makeEvent({ forwardedHost: 'paused.example.org' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('5')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('returns 404 when x-forwarded-host is missing (no apex bypass)', async () => {
    const resolve = vi.fn(async () => new Response('ok'))
    const event = makeEvent({ rawHost: 'stura.example.org' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(404)
    expect(resolveTenantBySlug).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('returns 404 for a bare apex forwarded host', async () => {
    const resolve = vi.fn(async () => new Response('ok'))
    const event = makeEvent({ forwardedHost: 'example.org' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(404)
    expect(resolveTenantBySlug).not.toHaveBeenCalled()
  })

  it('returns 503 (Retry-After) when the registry lookup THROWS', async () => {
    resolveTenantBySlug.mockRejectedValue(new Error('control DB connection refused'))
    const resolve = vi.fn(async () => new Response('ok'))
    const event = makeEvent({ forwardedHost: 'stura.example.org' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('5')
    expect(resolve).not.toHaveBeenCalled()
  })

  // ── P2.1b T3 (D-READY): per-tenant readiness gate at the seam ─────────────

  it('returns a tenant-scoped 503 + Retry-After and triggers the lazy retry for a FAILED tenant', async () => {
    const ctx = { id: 'tid-1', slug: 'stura' }
    resolveTenantBySlug.mockResolvedValue(ctx)
    readinessState.state = 'failed'
    const resolve = vi.fn(async () => new Response('ok'))
    const event = makeEvent({ forwardedHost: 'stura.example.org' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('5')
    expect(await res.text()).toBe('Service Unavailable: tenant not ready')
    expect(triggerTenantMigrationRetry).toHaveBeenCalledWith(ctx)
    expect(resolve).not.toHaveBeenCalled()
    expect(runWithTenant).not.toHaveBeenCalled()
    expect(event.locals.tenant).toBeUndefined()
  })

  it('returns the tenant-scoped 503 for a PENDING tenant too', async () => {
    resolveTenantBySlug.mockResolvedValue({ id: 'tid-1', slug: 'stura' })
    readinessState.state = 'pending'
    const resolve = vi.fn(async () => new Response('ok'))
    const event = makeEvent({ forwardedHost: 'stura.example.org' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(503)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('passes through while the fleet map is NOT yet populated (the process-wide boot gate owns pre-boot 503s)', async () => {
    resolveTenantBySlug.mockResolvedValue({ id: 'tid-1', slug: 'stura' })
    readinessState.populated = false
    readinessState.state = 'pending'
    const resolve = vi.fn(async () => new Response('ok', { status: 200 }))
    const event = makeEvent({ forwardedHost: 'stura.example.org' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(200)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(triggerTenantMigrationRetry).not.toHaveBeenCalled()
  })

  // ── P2.1b T10 (§7.6 D-RATE): per-tenant rate limit at the seam ────────────

  it('returns 429 + Retry-After when the tenant bucket trips — before ANY downstream work', async () => {
    const ctx = { id: 'tid-1', slug: 'stura' }
    resolveTenantBySlug.mockResolvedValue(ctx)
    rateLimitVerdict.value = { allowed: false, retryAfterSec: 7 }
    const resolve = vi.fn(async () => new Response('ok'))
    const event = makeEvent({ forwardedHost: 'stura.example.org' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('7')
    expect(checkTenantRateLimit).toHaveBeenCalledWith('tid-1')
    expect(resolve).not.toHaveBeenCalled()
    expect(runWithTenant).not.toHaveBeenCalled()
    expect(event.locals.tenant).toBeUndefined()
  })

  it('consults the limiter with the CANONICAL tenant id and passes through when allowed', async () => {
    resolveTenantBySlug.mockResolvedValue({ id: 'tid-1', slug: 'stura' })
    const resolve = vi.fn(async () => new Response('ok', { status: 200 }))
    const event = makeEvent({ forwardedHost: 'stura.example.org' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(200)
    expect(checkTenantRateLimit).toHaveBeenCalledTimes(1)
    expect(checkTenantRateLimit).toHaveBeenCalledWith('tid-1')
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('does NOT consume rate tokens for a tenant the readiness gate already 503s', async () => {
    resolveTenantBySlug.mockResolvedValue({ id: 'tid-1', slug: 'stura' })
    readinessState.state = 'failed'
    rateLimitVerdict.value = { allowed: false, retryAfterSec: 7 }
    const resolve = vi.fn(async () => new Response('ok'))
    const event = makeEvent({ forwardedHost: 'stura.example.org' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(503) // readiness wins — the ops signal stays clear
    expect(checkTenantRateLimit).not.toHaveBeenCalled()
  })

  it('never reaches the limiter for an unresolved tenant (404 path spends no bucket)', async () => {
    resolveTenantBySlug.mockResolvedValue(null)
    const resolve = vi.fn(async () => new Response('ok'))
    const event = makeEvent({ forwardedHost: 'ghost.example.org' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(404)
    expect(checkTenantRateLimit).not.toHaveBeenCalled()
  })

  // ── P2.1c T4: internal-trust bypass (constant-time x-internal-host-trust) ──
  // internalFetch's server-to-server hop re-injects the current tenant's
  // forwarded host + this secret so the resolver re-establishes the SAME
  // tenant WITHOUT the (T5) edge proxy-trust header. The resolver records the
  // trust on locals so T5's proxy-trust gate can honor it as an OR.

  it('resolves the tenant + marks selection trusted for a valid internal-host-trust (no T5 proxy header)', async () => {
    const ctx = { id: 'tid-2', slug: 't2' }
    resolveTenantBySlug.mockResolvedValue(ctx)
    const resolve = vi.fn(async () => new Response('ok', { status: 200 }))
    const event = makeEvent({
      forwardedHost: 't2.example.org',
      internalTrust: 'test-secret-32-bytes-of-padding-xxx',
    })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(200)
    expect(resolveTenantBySlug).toHaveBeenCalledWith('t2')
    expect(event.locals.tenant).toBe(ctx)
    expect(event.locals.tenantSelectionTrusted).toBe(true)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it("a request WITHOUT internal-trust keeps today's behavior (resolves, selection NOT trusted)", async () => {
    const ctx = { id: 'tid-1', slug: 'stura' }
    resolveTenantBySlug.mockResolvedValue(ctx)
    const resolve = vi.fn(async () => new Response('ok', { status: 200 }))
    const event = makeEvent({ forwardedHost: 'stura.example.org' })
    const res = (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
    expect(res.status).toBe(200)
    expect(event.locals.tenant).toBe(ctx)
    expect(event.locals.tenantSelectionTrusted).toBe(false)
  })

  it('an INVALID internal-trust value is not trusted (selection NOT trusted)', async () => {
    resolveTenantBySlug.mockResolvedValue({ id: 'tid-1', slug: 'stura' })
    const resolve = vi.fn(async () => new Response('ok', { status: 200 }))
    const event = makeEvent({ forwardedHost: 'stura.example.org', internalTrust: 'wrong-secret' })
    await tenantResolveHandle({ event: event as never, resolve } as never)
    expect(event.locals.tenantSelectionTrusted).toBe(false)
  })

  it('bypass is DISABLED (fail closed) when INTERNAL_PUSH_SECRET is unset, even with a header present', async () => {
    internalPushSecret.value = null
    resolveTenantBySlug.mockResolvedValue({ id: 'tid-2', slug: 't2' })
    const resolve = vi.fn(async () => new Response('ok', { status: 200 }))
    const event = makeEvent({
      forwardedHost: 't2.example.org',
      internalTrust: 'test-secret-32-bytes-of-padding-xxx',
    })
    await tenantResolveHandle({ event: event as never, resolve } as never)
    expect(event.locals.tenantSelectionTrusted).toBe(false)
  })
})

describe('isInternalTrustRequest', () => {
  beforeEach(() => {
    internalPushSecret.value = 'test-secret-32-bytes-of-padding-xxx'
  })

  it('returns true for a constant-time-matching x-internal-host-trust header', () => {
    const req = new Request('http://x/y', {
      headers: { 'x-internal-host-trust': 'test-secret-32-bytes-of-padding-xxx' },
    })
    expect(isInternalTrustRequest(req)).toBe(true)
  })

  it('returns false for a mismatching value', () => {
    const req = new Request('http://x/y', { headers: { 'x-internal-host-trust': 'nope' } })
    expect(isInternalTrustRequest(req)).toBe(false)
  })

  it('returns false when the header is absent', () => {
    expect(isInternalTrustRequest(new Request('http://x/y'))).toBe(false)
  })

  it('returns false (fail closed) when INTERNAL_PUSH_SECRET is unset', () => {
    internalPushSecret.value = null
    const req = new Request('http://x/y', {
      headers: { 'x-internal-host-trust': 'test-secret-32-bytes-of-padding-xxx' },
    })
    expect(isInternalTrustRequest(req)).toBe(false)
  })
})
