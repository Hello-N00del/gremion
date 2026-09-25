import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * TASK-023 (B-05 option 1): GET /healthz on gremion-ui.
 *
 * Always 200, body keys in the order ok, tenant, colour. `tenant` is the slug of
 * the tenant registered for the asked x-forwarded-host (Q6: an accepted
 * disclosure), or null — for no header, an unknown host, or a registry that is
 * down or slow. `colour` is COLOUR, read once at module load ('' by default).
 */

const resolveTenantByHost = vi.fn()
vi.mock('$lib/server/tenant/registry', () => ({
  RESOLUTION_CACHE_TTL_MS: 30_000,
  resolveTenantByHost: (h: string) => resolveTenantByHost(h),
}))

const savedColour = process.env.COLOUR

beforeEach(() => {
  vi.resetModules()
  resolveTenantByHost.mockReset()
  resolveTenantByHost.mockImplementation(async (h: string) =>
    h === 'musterstadt.example.org' ? { slug: 'musterstadt' } : h === 'beispiel.example' ? { slug: 'beispiel' } : null,
  )
  delete process.env.COLOUR
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  if (savedColour === undefined) delete process.env.COLOUR
  else process.env.COLOUR = savedColour
})

async function probe(mod: typeof import('./+server'), host?: string): Promise<Response> {
  const headers = new Headers()
  if (host !== undefined) headers.set('x-forwarded-host', host)
  return (await mod.GET({ request: new Request('http://127.0.0.1:3000/healthz', { headers }) } as never)) as Response
}

describe('GET /healthz (gremion-ui)', () => {
  it('no header gives exactly {"ok":true,"tenant":null,"colour":""} with no registry read', async () => {
    const mod = await import('./+server')
    const res = await probe(mod)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe('{"ok":true,"tenant":null,"colour":""}')
    expect(resolveTenantByHost).not.toHaveBeenCalled()
  })

  it('a registered host gives its slug; two registered hosts differ', async () => {
    const mod = await import('./+server')
    expect(await (await probe(mod, 'musterstadt.example.org')).text()).toBe(
      '{"ok":true,"tenant":"musterstadt","colour":""}',
    )
    expect(await (await probe(mod, 'Beispiel.Example:443')).text()).toBe('{"ok":true,"tenant":"beispiel","colour":""}')
  })

  it('an unknown host gives null, and is not looked up again within the cache TTL (Q6)', async () => {
    const mod = await import('./+server')
    for (let i = 0; i < 5; i++) {
      expect(await (await probe(mod, 'unknown.example.org')).text()).toBe('{"ok":true,"tenant":null,"colour":""}')
    }
    expect(resolveTenantByHost).toHaveBeenCalledTimes(1)
  })

  it('the unknown-host memo is bounded (a stream of random hosts cannot grow it without limit)', async () => {
    const mod = await import('./+server')
    for (let i = 0; i < mod._HEALTHZ_NEGATIVE_CACHE_MAX + 50; i++) await probe(mod, `h${i}.example.org`)
    expect(mod._negativeCacheSizeForTests()).toBeLessThanOrEqual(mod._HEALTHZ_NEGATIVE_CACHE_MAX)
  })

  it('a malformed host is null without a registry read', async () => {
    const mod = await import('./+server')
    for (const h of ['evil.example, musterstadt.example.org', 'a..b', 'x@y']) {
      expect(await (await probe(mod, h)).text()).toBe('{"ok":true,"tenant":null,"colour":""}')
    }
    expect(resolveTenantByHost).not.toHaveBeenCalled()
  })

  it('a registry throw still gives 200 with null', async () => {
    vi.spyOn(console, 'warn').mockImplementationOnce(() => {})
    resolveTenantByHost.mockRejectedValue(new Error('control DB unreachable'))
    const mod = await import('./+server')
    const res = await probe(mod, 'musterstadt.example.org')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('{"ok":true,"tenant":null,"colour":""}')
  })

  it('a registry that hangs gives 200 with null after the lookup timeout', async () => {
    vi.useFakeTimers()
    resolveTenantByHost.mockImplementation(() => new Promise(() => {}))
    const mod = await import('./+server')
    const pending = probe(mod, 'musterstadt.example.org')
    await vi.advanceTimersByTimeAsync(mod._HEALTHZ_LOOKUP_TIMEOUT_MS)
    const res = await pending
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('{"ok":true,"tenant":null,"colour":""}')
  })

  it('a timed-out lookup is logged and memoised as an error (5 s), not as a 30 s miss', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveTenantByHost.mockImplementation(() => new Promise(() => {}))
    const mod = await import('./+server')
    const first = probe(mod, 'musterstadt.example.org')
    await vi.advanceTimersByTimeAsync(mod._HEALTHZ_LOOKUP_TIMEOUT_MS)
    await first
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0].join(' '))).toMatch(/timed out/)
    // Within the error memo: no new lookup.
    await probe(mod, 'musterstadt.example.org')
    expect(resolveTenantByHost).toHaveBeenCalledTimes(1)
    // After it, the host is looked up again (a real tenant is not hidden for 30 s).
    resolveTenantByHost.mockImplementation(async () => ({ slug: 'musterstadt' }))
    await vi.advanceTimersByTimeAsync(5_001)
    expect(await (await probe(mod, 'musterstadt.example.org')).text()).toBe(
      '{"ok":true,"tenant":"musterstadt","colour":""}',
    )
    warn.mockRestore()
  })

  it('concurrent probes for one uncached host share a single lookup', async () => {
    let release: (v: unknown) => void = () => {}
    resolveTenantByHost.mockImplementation(() => new Promise((r) => (release = r)))
    const mod = await import('./+server')
    const probes = Array.from({ length: 10 }, () => probe(mod, 'musterstadt.example.org'))
    await vi.waitFor(() => expect(resolveTenantByHost).toHaveBeenCalled())
    release({ slug: 'musterstadt' })
    const bodies = await Promise.all(probes.map(async (p) => (await p).text()))
    expect(resolveTenantByHost).toHaveBeenCalledTimes(1)
    expect(new Set(bodies)).toEqual(new Set(['{"ok":true,"tenant":"musterstadt","colour":""}']))
  })

  it('registry errors for many hosts log at most once per 5 s window', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveTenantByHost.mockRejectedValue(new Error('control DB unreachable'))
    const mod = await import('./+server')
    for (let i = 0; i < 20; i++) await probe(mod, `h${i}.example.org`)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('the body is byte-identical for two probes of one host', async () => {
    const mod = await import('./+server')
    const a = await (await probe(mod, 'musterstadt.example.org')).text()
    const b = await (await probe(mod, 'musterstadt.example.org')).text()
    expect(a).toBe(b)
  })

  it('keys are in the order ok, tenant, colour', async () => {
    const mod = await import('./+server')
    const body = await (await probe(mod, 'musterstadt.example.org')).text()
    expect(Object.keys(JSON.parse(body))).toEqual(['ok', 'tenant', 'colour'])
  })

  it('COLOUR is read once, at module load', async () => {
    process.env.COLOUR = 'blue'
    const mod = await import('./+server')
    process.env.COLOUR = 'green'
    expect(await (await probe(mod)).text()).toBe('{"ok":true,"tenant":null,"colour":"blue"}')
    delete process.env.COLOUR
    expect(await (await probe(mod)).text()).toBe('{"ok":true,"tenant":null,"colour":"blue"}')
  })
})
