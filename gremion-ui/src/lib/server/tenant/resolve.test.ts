// TASK-041 (L3-08; PRD-PLAT-012, TRD-074/075/076) — tenantResolveHandle under
// WHOLE-HOST tenant selection (Tenancy D1, spec §1.3; B10-resolver-fullhost).
//
// This handle is the cross-tenant isolation boundary: whatever it puts on
// `event.locals.tenant` decides which tenant's DATABASE the rest of the request
// touches. So every case below asserts either an exact selection or an explicit
// refusal, and several assert the NEGATIVE directly (`not.toHaveBeenCalled`,
// `not.toHaveBeenCalledWith`) — a 404 that happens to be right for the wrong
// reason is not good enough here.
//
// `normaliseHost` (host.ts) is the REAL implementation throughout: it is pure,
// it is half of the security property under test, and its own edge cases are
// pinned in host.test.ts. Only the registry (control-DB I/O) and the
// host-rejection emitter (whose bounds are pinned in host-mismatch-log.test.ts)
// are mocked, so each test can assert exactly which reason a 404 carried.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { SUSPENDED_PAGE_MARKER } from './suspended-page'

const resolveTenantByHost = vi.fn()
const getTenantStatusByHost = vi.fn()
const resolveTenantById = vi.fn()
const runWithTenant = vi.fn(async (_ctx: unknown, fn: () => unknown) => fn())

vi.mock('$lib/server/tenant/registry', () => ({
  // D1 §1.3: the resolver's ONLY host selector. There is deliberately no
  // by-slug export in this mock — if the handle ever reaches for one again,
  // the test run fails loudly instead of silently resurrecting the label model.
  resolveTenantByHost: (host: string) => resolveTenantByHost(host),
  // P2.1c (T6): status-only lookup consulted on the resolver's null path.
  getTenantStatusByHost: (host: string) => getTenantStatusByHost(host),
  // Spec B §T.1 HARDENING-3: the leaf-callback id path (unchanged here).
  resolveTenantById: (id: string) => resolveTenantById(id),
}))
// TRD-076: every host-path 404 emits one event; the emitter is a spy here.
const logHostRejection = vi.fn()
vi.mock('$lib/server/tenant/host-mismatch-log', () => ({
  logHostRejection: (reason: string, host: string | null) => logHostRejection(reason, host),
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
  // P2.1c (T19): the resolver's request-error path logs via the tenant-tagged
  // tlog seam, which reads getTenantOrNull(). No context is active on that path
  // (resolution itself failed), so it returns null here.
  getTenantOrNull: () => null,
}))
// P2.1b T3 (D-READY): the per-tenant readiness gate is mocked here so each test
// steers the tenant's state directly; the REAL map + retry semantics are pinned
// in readiness.test.ts. Defaults = fleet populated + tenant ready.
const readinessState = { populated: true, state: 'ready' as 'ready' | 'failed' | 'pending' }
const triggerTenantMigrationRetry = vi.fn()
vi.mock('$lib/server/tenant/readiness', () => ({
  isFleetPopulated: () => readinessState.populated,
  getTenantReadiness: () => readinessState.state,
  triggerTenantMigrationRetry: (t: unknown) => triggerTenantMigrationRetry(t),
}))

// P2.1b T10 (§7.6 D-RATE): the per-tenant rate limiter is mocked here so each
// test steers the verdict directly; the REAL token-bucket semantics are pinned
// in rate-limit.test.ts. Default = allowed.
const rateLimitVerdict = {
  value: { allowed: true } as { allowed: true } | { allowed: false; retryAfterSec: number },
}
const checkTenantRateLimit = vi.fn((_tenantId: string) => rateLimitVerdict.value)
vi.mock('$lib/server/tenant/rate-limit', () => ({
  checkTenantRateLimit: (tenantId: string) => checkTenantRateLimit(tenantId),
}))

// P2.1c T4/T5: the internal-trust secret and the proxy-trust secret are steered
// here; `constantTimeEqual` is the REAL implementation. The proxy-trust secret
// defaults to null (gate and Q2 cross-check both off) so the host-path cases
// exercise selection alone; the cross-check block turns it on.
const INTERNAL_SECRET = 'test-secret-32-bytes-of-padding-xxx'
const PROXY_SECRET = 'proxy-secret-32-bytes-of-padding!!!!'
const internalPushSecret = { value: INTERNAL_SECRET as string | null }
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

const { tenantResolveHandle, isInternalTrustRequest } = await import('./resolve')

// Two tenants on hosts that have NOTHING structurally in common with each other
// or with a subdomain scheme — that is the D1 shape: a tenant brings its own
// domain. `rat-musterstadt` is a foreign 2-label apex, which the old
// ≥3-label rule made unservable. The default tenant binds no host (TRD-075).
const ACME_CTX = { id: 'tid-acme', slug: 'acme' }
const MUSTERSTADT_CTX = { id: 'tid-must', slug: 'rat-musterstadt' }
const REGISTERED: Record<string, { id: string; slug: string }> = {
  'council.example': ACME_CTX,
  'www.council.example': ACME_CTX,
  'rat-musterstadt.de': MUSTERSTADT_CTX,
  'www.rat-musterstadt.de': MUSTERSTADT_CTX,
}

function makeEvent(opts: {
  forwardedHost?: string
  rawHost?: string
  path?: string
  internalTrust?: string
  proxyTrust?: string
  extra?: Record<string, string>
}) {
  const headers = new Headers()
  if (opts.forwardedHost !== undefined) headers.set('x-forwarded-host', opts.forwardedHost)
  if (opts.rawHost !== undefined) headers.set('host', opts.rawHost)
  if (opts.internalTrust !== undefined) headers.set('x-internal-host-trust', opts.internalTrust)
  if (opts.proxyTrust !== undefined) headers.set('x-proxy-trust', opts.proxyTrust)
  for (const [k, v] of Object.entries(opts.extra ?? {})) headers.set(k, v)
  const url = new URL(`http://internal${opts.path ?? '/dashboard'}`)
  return { url, request: new Request(url, { headers }), locals: {} as Record<string, unknown>, params: {} }
}
const ok = () => vi.fn(async () => new Response('ok', { status: 200 }))
async function run(event: ReturnType<typeof makeEvent>, resolve = ok()) {
  return (await tenantResolveHandle({ event: event as never, resolve } as never)) as Response
}
const registryCalls = () => resolveTenantByHost.mock.calls.length + getTenantStatusByHost.mock.calls.length

beforeEach(() => {
  resolveTenantByHost.mockReset()
  // The registry table IS the source of truth: a host that is not a row
  // resolves to null. No fallback lives in this fixture either.
  resolveTenantByHost.mockImplementation(async (host: string) => REGISTERED[host] ?? null)
  getTenantStatusByHost.mockReset()
  getTenantStatusByHost.mockResolvedValue(null)
  resolveTenantById.mockReset()
  resolveTenantById.mockResolvedValue(null)
  logHostRejection.mockReset()
  getPoolForTenant.mockClear()
  runWithTenant.mockReset()
  runWithTenant.mockImplementation(async (_ctx: unknown, fn: () => unknown) => fn())
  triggerTenantMigrationRetry.mockReset()
  readinessState.populated = true
  readinessState.state = 'ready'
  checkTenantRateLimit.mockClear()
  rateLimitVerdict.value = { allowed: true }
  internalPushSecret.value = INTERNAL_SECRET
  proxyTrustSecret.value = null
})

describe('tenantResolveHandle: the WHOLE host is the key', () => {
  it('resolves the FULL forwarded host -> TenantContext on locals and wraps downstream', async () => {
    const downstream = new Response('ok', { status: 200 })
    const resolve = vi.fn(async () => downstream)
    const event = makeEvent({ forwardedHost: 'council.example' })
    const res = await tenantResolveHandle({ event: event as never, resolve } as never)
    expect(resolveTenantByHost).toHaveBeenCalledWith('council.example')
    expect(event.locals.tenant).toBe(ACME_CTX)
    expect(runWithTenant).toHaveBeenCalledTimes(1)
    expect(runWithTenant.mock.calls[0][0]).toBe(ACME_CTX)
    expect(resolve).toHaveBeenCalledWith(event)
    expect(res).toBe(downstream)
    expect(logHostRejection).not.toHaveBeenCalled()
  })

  it('never selects on the raw Host header: it reads only x-forwarded-host', async () => {
    const event = makeEvent({ forwardedHost: 'council.example', rawHost: 'rat-musterstadt.de' })
    await run(event)
    expect(resolveTenantByHost).toHaveBeenCalledTimes(1)
    expect(resolveTenantByHost).toHaveBeenCalledWith('council.example')
    expect(event.locals.tenant).toBe(ACME_CTX)
  })

  it('normalises the edge form (case / port / one trailing dot) onto ONE lookup key', async () => {
    for (const raw of ['COUNCIL.EXAMPLE', 'Council.Example:443', 'council.example.', '  council.example  ']) {
      resolveTenantByHost.mockClear()
      const event = makeEvent({ forwardedHost: raw })
      const res = await run(event)
      expect(res.status).toBe(200)
      expect(resolveTenantByHost.mock.calls).toEqual([['council.example']])
      expect(event.locals.tenant).toBe(ACME_CTX)
    }
  })

  it("a tenant's own 2-label APEX resolves its tenant (the old ≥3-label rule 404'd it)", async () => {
    const event = makeEvent({ forwardedHost: 'rat-musterstadt.de' })
    const res = await run(event)
    expect(res.status).toBe(200)
    expect(resolveTenantByHost).toHaveBeenCalledWith('rat-musterstadt.de')
    expect(event.locals.tenant).toBe(MUSTERSTADT_CTX)
  })

  it('acme.example.org is looked up WHOLE — never as the slug acme', async () => {
    const event = makeEvent({ forwardedHost: 'acme.example.org' })
    const res = await run(event)
    // acme is a real slug (ACME_CTX), but acme.example.org is no tenant_domain row.
    expect(res.status).toBe(404)
    expect(resolveTenantByHost).toHaveBeenCalledWith('acme.example.org')
    expect(resolveTenantByHost).not.toHaveBeenCalledWith('acme')
    expect(event.locals.tenant).toBeUndefined()
    expect(logHostRejection).toHaveBeenCalledWith('unbound', 'acme.example.org')
  })

  it('a foreign 3-label host resolves because it is registered WHOLE, not by its leftmost label', async () => {
    const event = makeEvent({ forwardedHost: 'www.rat-musterstadt.de' })
    const res = await run(event)
    expect(res.status).toBe(200)
    expect(event.locals.tenant).toBe(MUSTERSTADT_CTX)
    expect(resolveTenantByHost).not.toHaveBeenCalledWith('www')
  })

  it('REJECTS a registered host used as a PREFIX or SUFFIX of a foreign name', async () => {
    for (const spoof of ['council.example.attacker.example', 'evil-council.example', 'rat-musterstadt.de.evil.test']) {
      const event = makeEvent({ forwardedHost: spoof })
      const res = await run(event)
      expect(res.status).toBe(404)
      expect(event.locals.tenant).toBeUndefined()
    }
  })
})

describe('tenantResolveHandle: unparseable hosts 404 with no registry read', () => {
  it('rejects the #256-2 and D1 authority forms before any lookup, as reason unparseable', async () => {
    for (const raw of [
      'a.b, c.d', // comma-joined multi-value header
      'a.b,c.d',
      'a.b c.d', // whitespace list
      'tenant..org', // empty label
      '.tenant.example.org', // leading empty label
      'tenant.example.org..', // second trailing dot
      '[::1]:443', // IPv6 literal (the old parser yielded '[')
      'evil.example.org:80@x', // userinfo smuggling (old split(':',1) accepted this)
      'council.example:notaport',
      '*.council.example', // wildcard
      'bücher.example', // raw non-ASCII: IDN must arrive as punycode A-labels
    ]) {
      resolveTenantByHost.mockClear()
      getTenantStatusByHost.mockClear()
      logHostRejection.mockClear()
      const event = makeEvent({ forwardedHost: raw })
      const res = await run(event)
      expect(res.status, raw).toBe(404)
      expect(registryCalls(), raw).toBe(0)
      expect(event.locals.tenant).toBeUndefined()
      expect(logHostRejection.mock.calls, raw).toEqual([['unparseable', raw]])
    }
  })

  it('an ABSENT x-forwarded-host is unparseable: 404, no registry read, one event', async () => {
    const event = makeEvent({ rawHost: 'council.example' })
    const res = await run(event)
    expect(res.status).toBe(404)
    expect(registryCalls()).toBe(0)
    expect(logHostRejection.mock.calls).toEqual([['unparseable', null]])
  })
})

describe('tenantResolveHandle: outcomes', () => {
  it('an unbound host is a 404, reads status once, and emits reason unbound — no default tenant, ever', async () => {
    const resolve = ok()
    const event = makeEvent({ forwardedHost: 'ghost.example.org' })
    const res = await run(event, resolve)
    expect(res.status).toBe(404)
    expect(getTenantStatusByHost.mock.calls).toEqual([['ghost.example.org']])
    expect(resolve).not.toHaveBeenCalled()
    expect(runWithTenant).not.toHaveBeenCalled()
    expect(event.locals.tenant).toBeUndefined()
    expect(logHostRejection.mock.calls).toEqual([['unbound', 'ghost.example.org']])
  })

  it('a SUSPENDED tenant host is the branded 503 (no pool touched) and emits NO event', async () => {
    getTenantStatusByHost.mockResolvedValue('suspended')
    const resolve = ok()
    const event = makeEvent({ forwardedHost: 'PAUSED.Example.ORG:443' })
    const res = await run(event, resolve)
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('3600')
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    const body = await res.text()
    expect(body).toContain(SUSPENDED_PAGE_MARKER)
    expect(getTenantStatusByHost).toHaveBeenCalledWith('paused.example.org') // normalised
    expect(getPoolForTenant).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(event.locals.tenant).toBeUndefined()
    expect(logHostRejection).not.toHaveBeenCalled()
  })

  it.each(['deleting', 'deleted'])('a %s tenant host is a 404 tombstone with reason inactive', async (status) => {
    getTenantStatusByHost.mockResolvedValue(status)
    const resolve = ok()
    const event = makeEvent({ forwardedHost: 'gone.example.org' })
    const res = await run(event, resolve)
    expect(res.status).toBe(404)
    expect(getPoolForTenant).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(logHostRejection.mock.calls).toEqual([['inactive', 'gone.example.org']])
  })

  it('an ACTIVE tenant never consults the status lookup', async () => {
    const event = makeEvent({ forwardedHost: 'council.example' })
    const res = await run(event)
    expect(res.status).toBe(200)
    expect(getTenantStatusByHost).not.toHaveBeenCalled()
  })

  it('registry down (host lookup throws) is a 503 with Retry-After 5 and NO event', async () => {
    resolveTenantByHost.mockRejectedValue(new Error('control DB connection refused'))
    const resolve = ok()
    const event = makeEvent({ forwardedHost: 'council.example' })
    const res = await run(event, resolve)
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('5')
    expect(resolve).not.toHaveBeenCalled()
    expect(event.locals.tenant).toBeUndefined()
    expect(logHostRejection).not.toHaveBeenCalled()
  })

  it('registry down (status lookup throws) is a 503 and NO event', async () => {
    getTenantStatusByHost.mockRejectedValue(new Error('control DB connection refused'))
    const event = makeEvent({ forwardedHost: 'paused.example.org' })
    const res = await run(event)
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('5')
    expect(logHostRejection).not.toHaveBeenCalled()
  })

  it('an emitter that throws cannot turn the 404 into anything else', async () => {
    logHostRejection.mockImplementation(() => {
      throw new Error('log sink down')
    })
    const res = await run(makeEvent({ forwardedHost: 'ghost.example.org' }))
    expect(res.status).toBe(404)
  })

  // ── P2.1b T3 (D-READY): per-tenant readiness gate (unchanged) ─────────────

  it('a FAILED tenant is a tenant-scoped 503 and triggers the lazy retry', async () => {
    readinessState.state = 'failed'
    const resolve = ok()
    const event = makeEvent({ forwardedHost: 'council.example' })
    const res = await run(event, resolve)
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('5')
    expect(await res.text()).toBe('Service Unavailable: tenant not ready')
    expect(triggerTenantMigrationRetry).toHaveBeenCalledWith(ACME_CTX)
    expect(resolve).not.toHaveBeenCalled()
    expect(event.locals.tenant).toBeUndefined()
    expect(logHostRejection).not.toHaveBeenCalled()
  })

  it('a PENDING tenant is the tenant-scoped 503 too', async () => {
    readinessState.state = 'pending'
    const res = await run(makeEvent({ forwardedHost: 'council.example' }))
    expect(res.status).toBe(503)
  })

  it('passes through while the fleet map is NOT yet populated', async () => {
    readinessState.populated = false
    readinessState.state = 'pending'
    const resolve = ok()
    const res = await run(makeEvent({ forwardedHost: 'council.example' }), resolve)
    expect(res.status).toBe(200)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(triggerTenantMigrationRetry).not.toHaveBeenCalled()
  })

  // ── P2.1b T10 (§7.6 D-RATE): per-tenant rate limit (unchanged) ────────────

  it('returns 429 + Retry-After when the tenant bucket trips — before ANY downstream work', async () => {
    rateLimitVerdict.value = { allowed: false, retryAfterSec: 7 }
    const resolve = ok()
    const event = makeEvent({ forwardedHost: 'council.example' })
    const res = await run(event, resolve)
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('7')
    expect(checkTenantRateLimit).toHaveBeenCalledWith('tid-acme')
    expect(resolve).not.toHaveBeenCalled()
    expect(event.locals.tenant).toBeUndefined()
  })

  it('buckets per TENANT, not per host — two hosts of one tenant share its bucket', async () => {
    for (const host of ['council.example', 'www.council.example']) await run(makeEvent({ forwardedHost: host }))
    expect(checkTenantRateLimit.mock.calls).toEqual([['tid-acme'], ['tid-acme']])
  })

  it('does NOT consume rate tokens for a tenant the readiness gate already 503s', async () => {
    readinessState.state = 'failed'
    rateLimitVerdict.value = { allowed: false, retryAfterSec: 7 }
    const res = await run(makeEvent({ forwardedHost: 'council.example' }))
    expect(res.status).toBe(503)
    expect(checkTenantRateLimit).not.toHaveBeenCalled()
  })

  it('never reaches the limiter for an unresolved host', async () => {
    const res = await run(makeEvent({ forwardedHost: 'ghost.example.org' }))
    expect(res.status).toBe(404)
    expect(checkTenantRateLimit).not.toHaveBeenCalled()
  })
})

describe('tenantResolveHandle: proxy-trust gate (T5) still precedes the host path', () => {
  it('a request without x-proxy-trust is a 403 before any lookup and emits no host event', async () => {
    proxyTrustSecret.value = PROXY_SECRET
    const event = makeEvent({ forwardedHost: 'council.example', rawHost: 'council.example' })
    const res = await run(event)
    expect(res.status).toBe(403)
    expect(registryCalls()).toBe(0)
    expect(logHostRejection).not.toHaveBeenCalled()
  })
})

describe('tenantResolveHandle: Q2 cross-check of Host against X-Forwarded-Host', () => {
  beforeEach(() => {
    proxyTrustSecret.value = PROXY_SECRET
  })

  it('an edge request whose Host differs from X-Forwarded-Host is a 404 forged, before any lookup', async () => {
    const resolve = ok()
    const event = makeEvent({ rawHost: 'a.x', forwardedHost: 'b.x', proxyTrust: PROXY_SECRET })
    const res = await run(event, resolve)
    expect(res.status).toBe(404)
    expect(registryCalls()).toBe(0)
    expect(resolve).not.toHaveBeenCalled()
    expect(event.locals.tenant).toBeUndefined()
    expect(logHostRejection.mock.calls).toEqual([['forged', 'b.x']])
  })

  it('a forged X-Forwarded-Host naming a REGISTERED customer does not select it', async () => {
    const event = makeEvent({
      rawHost: 'unbound.example',
      forwardedHost: 'council.example',
      proxyTrust: PROXY_SECRET,
    })
    const res = await run(event)
    expect(res.status).toBe(404)
    expect(resolveTenantByHost).not.toHaveBeenCalled()
    expect(event.locals.tenant).toBeUndefined()
    expect(logHostRejection.mock.calls).toEqual([['forged', 'council.example']])
  })

  it('an edge request with NO Host header at all is forged too', async () => {
    const event = makeEvent({ forwardedHost: 'council.example', proxyTrust: PROXY_SECRET })
    const res = await run(event)
    expect(res.status).toBe(404)
    expect(registryCalls()).toBe(0)
    expect(logHostRejection.mock.calls).toEqual([['forged', 'council.example']])
  })

  it('compares NORMALISED forms: Host A.X:443 equals X-Forwarded-Host a.x', async () => {
    resolveTenantByHost.mockImplementation(async (h: string) => (h === 'a.x' ? ACME_CTX : null))
    const event = makeEvent({ rawHost: 'A.X:443', forwardedHost: 'a.x', proxyTrust: PROXY_SECRET })
    const res = await run(event)
    expect(res.status).toBe(200)
    expect(event.locals.tenant).toBe(ACME_CTX)
    expect(logHostRejection).not.toHaveBeenCalled()
  })

  it('a matching edge request resolves normally (reject-only: the check never selects)', async () => {
    const event = makeEvent({ rawHost: 'council.example', forwardedHost: 'council.example', proxyTrust: PROXY_SECRET })
    const res = await run(event)
    expect(res.status).toBe(200)
    expect(resolveTenantByHost.mock.calls).toEqual([['council.example']])
  })

  it('an unparseable X-Forwarded-Host is reported as unparseable, not forged', async () => {
    const event = makeEvent({ rawHost: 'council.example', forwardedHost: 'a.b, c.d', proxyTrust: PROXY_SECRET })
    const res = await run(event)
    expect(res.status).toBe(404)
    expect(logHostRejection.mock.calls).toEqual([['unparseable', 'a.b, c.d']])
  })

  it('an internalFetch hop (valid x-internal-host-trust) is NOT cross-checked', async () => {
    const event = makeEvent({
      rawHost: 'gremion-ui:3000',
      forwardedHost: 'rat-musterstadt.de',
      internalTrust: INTERNAL_SECRET,
    })
    const res = await run(event)
    expect(res.status).toBe(200)
    expect(event.locals.tenant).toBe(MUSTERSTADT_CTX)
    expect(event.locals.tenantSelectionTrusted).toBe(true)
    expect(logHostRejection).not.toHaveBeenCalled()
  })

  it('a leaf callback claim is NOT cross-checked (the id path is unchanged)', async () => {
    const saved = process.env.INTERNAL_NEWSLETTER_SECRET
    process.env.INTERNAL_NEWSLETTER_SECRET = 'newsletter-secret-32-bytes-of-padxx'
    try {
      const TENANT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
      resolveTenantById.mockResolvedValue({ id: TENANT_ID, slug: 'rat-musterstadt' })
      const event = makeEvent({
        path: '/api/internal/newsletter/render',
        rawHost: 'gremion-ui:3000',
        forwardedHost: 'council.example',
        extra: {
          'x-internal-auth': 'newsletter-secret-32-bytes-of-padxx',
          'x-tenant-id': TENANT_ID,
        },
      })
      const res = await run(event)
      expect(res.status).toBe(200)
      expect(resolveTenantById).toHaveBeenCalledWith(TENANT_ID)
      expect(registryCalls()).toBe(0)
      expect(logHostRejection).not.toHaveBeenCalled()
    } finally {
      if (saved === undefined) delete process.env.INTERNAL_NEWSLETTER_SECRET
      else process.env.INTERNAL_NEWSLETTER_SECRET = saved
    }
  })

  it('with the proxy-trust secret UNSET the check is off (no edge contract to hold it to)', async () => {
    proxyTrustSecret.value = null
    const event = makeEvent({ rawHost: 'a.x', forwardedHost: 'council.example' })
    const res = await run(event)
    expect(res.status).toBe(200)
    expect(event.locals.tenant).toBe(ACME_CTX)
  })
})

describe('tenantResolveHandle: internal-trust bypass (T4)', () => {
  it('resolves the tenant + marks selection trusted for a valid internal-host-trust', async () => {
    const resolve = ok()
    const event = makeEvent({ forwardedHost: 'rat-musterstadt.de', internalTrust: INTERNAL_SECRET })
    const res = await run(event, resolve)
    expect(res.status).toBe(200)
    expect(resolveTenantByHost).toHaveBeenCalledWith('rat-musterstadt.de')
    expect(event.locals.tenant).toBe(MUSTERSTADT_CTX)
    expect(event.locals.tenantSelectionTrusted).toBe(true)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('internal trust does NOT widen host selection: an unregistered host still 404s', async () => {
    const event = makeEvent({ forwardedHost: 'acme.attacker.example', internalTrust: INTERNAL_SECRET })
    const res = await run(event)
    expect(res.status).toBe(404)
    expect(event.locals.tenant).toBeUndefined()
  })

  it("a request WITHOUT internal-trust resolves with selection NOT trusted", async () => {
    const event = makeEvent({ forwardedHost: 'council.example' })
    const res = await run(event)
    expect(res.status).toBe(200)
    expect(event.locals.tenantSelectionTrusted).toBe(false)
  })

  it('an INVALID internal-trust value is not trusted', async () => {
    const event = makeEvent({ forwardedHost: 'council.example', internalTrust: 'wrong-secret' })
    await run(event)
    expect(event.locals.tenantSelectionTrusted).toBe(false)
  })

  it('bypass is DISABLED (fail closed) when INTERNAL_PUSH_SECRET is unset', async () => {
    internalPushSecret.value = null
    const event = makeEvent({ forwardedHost: 'rat-musterstadt.de', internalTrust: INTERNAL_SECRET })
    await run(event)
    expect(event.locals.tenantSelectionTrusted).toBe(false)
  })
})

describe('isInternalTrustRequest', () => {
  afterEach(() => {
    internalPushSecret.value = INTERNAL_SECRET
  })

  it('returns true for a constant-time-matching x-internal-host-trust header', () => {
    const req = new Request('http://x/y', { headers: { 'x-internal-host-trust': INTERNAL_SECRET } })
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
    const req = new Request('http://x/y', { headers: { 'x-internal-host-trust': INTERNAL_SECRET } })
    expect(isInternalTrustRequest(req)).toBe(false)
  })
})
