// TDD 2 (host) and TDD 3 (status), brief s.1 "Host" and "Status": the
// request -> customer matrix, counting registry reads and host-rejection
// events. Reference matrix: gremion-ui resolve.ts resolveByForwardedHost
// (lane note C11), with the kernel API's two hardenings: the proxy secret is
// REQUIRED (boot refuses without it; a missing header is 403), and Host must
// always equal X-Forwarded-Host.
import { describe, expect, it } from 'vitest'
import { ConfigError, readConfig } from '../../src/app/config.ts'
import { A_HOST, A_ID, appWith, B_HOST, B_ID, edge, PROXY_SECRET, reads, rejectedReasons, tenantRow, world } from '../harness/fakes.ts'

const SELF = '/api/v1/tenancy/self'

describe('host path (TDD 2)', () => {
  it("A's host with A's token -> 200 naming A: one host lookup, one token check, one gate check", async () => {
    const { app, rec } = appWith(world())
    const res = await app.inject({ url: SELF, headers: edge(A_HOST, 'token-a') })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ customerId: A_ID, slug: 'a', realm: 'realm-a' })
    expect(rec.hostLookups).toEqual([A_HOST])
    expect(rec.gateChecks).toEqual([A_ID])
    expect(rec.events).toEqual([])
    await app.close()
  })

  it('B on its own host resolves to B (two-tenant routing)', async () => {
    const { app } = appWith(world())
    const res = await app.inject({ url: SELF, headers: edge(B_HOST, 'token-b') })
    expect(res.json()).toMatchObject({ customerId: B_ID, slug: 'council-b' })
    await app.close()
  })

  it.each([
    ['no x-proxy-trust', { 'x-proxy-trust': '' }],
    ['a wrong x-proxy-trust', { 'x-proxy-trust': `${PROXY_SECRET}x` }],
    ['a prefix of the secret', { 'x-proxy-trust': PROXY_SECRET.slice(0, -1) }],
  ])('%s -> 403, zero registry reads, no event', async (_n, over) => {
    const { app, rec } = appWith(world())
    const headers = edge(A_HOST, 'token-a', over)
    if (!over['x-proxy-trust']) delete headers['x-proxy-trust']
    const res = await app.inject({ url: SELF, headers })
    expect(res.statusCode).toBe(403)
    expect(reads(rec)).toBe(0)
    expect(rec.events).toEqual([])
    await app.close()
  })

  it.each([
    ['absent', undefined],
    ['a list', 'a.example.org, evil.example'],
    ['userinfo smuggling', 'evil.com:80@a.example.org'],
    ['an empty label', 'a..example.org'],
    ['raw unicode', 'bücher.example'],
  ])('X-Forwarded-Host %s -> 404 unparseable, zero registry reads', async (_n, xfh) => {
    const { app, rec } = appWith(world())
    const headers = edge(A_HOST, 'token-a')
    if (xfh === undefined) delete headers['x-forwarded-host']
    else headers['x-forwarded-host'] = xfh
    const res = await app.inject({ url: SELF, headers })
    expect(res.statusCode).toBe(404)
    expect(reads(rec)).toBe(0)
    expect(rejectedReasons(rec)).toEqual(['unparseable'])
    await app.close()
  })

  it('Host != X-Forwarded-Host -> 404 forged, zero registry reads', async () => {
    const { app, rec } = appWith(world())
    const res = await app.inject({ url: SELF, headers: edge(A_HOST, 'token-a', { host: B_HOST }) })
    expect(res.statusCode).toBe(404)
    expect(reads(rec)).toBe(0)
    expect(rejectedReasons(rec)).toEqual(['forged'])
    await app.close()
  })

  it('Host and X-Forwarded-Host differing only in case, port or the root dot are the same host', async () => {
    const { app } = appWith(world())
    const res = await app.inject({ url: SELF, headers: edge(A_HOST, 'token-a', { host: 'A.Example.org:443', 'x-forwarded-host': 'a.example.org.' }) })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it.each(['example.org', 'control.example.org', 'www.example.org', 'mta-sts.example.org'])('reserved %s -> 404, zero registry reads', async (host) => {
    const w = world()
    w.domains.set(host, A_ID) // even a (wrongly) bound reserved name never resolves
    const { app, rec } = appWith(w)
    const res = await app.inject({ url: SELF, headers: edge(host, 'token-a') })
    expect(res.statusCode).toBe(404)
    expect(reads(rec)).toBe(0)
    expect(rec.events).toHaveLength(1)
    await app.close()
  })

  it('an unbound <A-slug>.<apex> -> 404 after EXACTLY one lookup and ONE tenant.host.rejected event (G6)', async () => {
    // A brings its own domain; the synthesised <slug>.<apex> is NOT A (Tenancy D1: no slug arithmetic).
    const w = world()
    w.domains.delete(A_HOST)
    w.domains.set('council-a.example', A_ID)
    const { app, rec } = appWith(w)
    const res = await app.inject({ url: SELF, headers: edge(A_HOST, 'token-a') })
    expect(res.statusCode).toBe(404)
    expect(rec.hostLookups).toEqual([A_HOST])
    expect(rejectedReasons(rec)).toEqual(['unbound'])
    expect(rec.events[0]!.fields).toMatchObject({ host: A_HOST, reason: 'unbound' })
    expect(rec.tokenChecks).toEqual([])
    expect((await app.inject({ url: SELF, headers: edge('council-a.example', 'token-a') })).json()).toMatchObject({ customerId: A_ID })
    await app.close()
  })

  it('RED reference (leftmost label): a subdomain of a bound host is NOT that tenant -- the whole host is the key', async () => {
    const { app, rec } = appWith(world())
    const res = await app.inject({ url: SELF, headers: edge(`x.${A_HOST}`, 'token-a') })
    expect(res.statusCode).toBe(404)
    expect(rec.hostLookups).toEqual([`x.${A_HOST}`])
    expect(rec.tokenChecks).toEqual([])
    await app.close()
  })

  it('a flood of unbound hosts is bounded by the emitter (dedupe per host)', async () => {
    const { app, rec } = appWith(world())
    for (let i = 0; i < 3; i++) await app.inject({ url: SELF, headers: edge('nobody.example', 'token-a') })
    expect(rec.events).toHaveLength(1)
    await app.close()
  })
})

describe('status table (TDD 3)', () => {
  it.each(['provisioning', 'deleting', 'deleted'] as const)('%s -> 404 inactive, no token check, no gate', async (status) => {
    const w = world()
    w.tenants.set(A_ID, tenantRow(A_ID, 'a', status))
    const { app, rec } = appWith(w)
    const res = await app.inject({ url: SELF, headers: edge(A_HOST, 'token-a') })
    expect(res.statusCode).toBe(404)
    expect(rejectedReasons(rec)).toEqual(['inactive'])
    expect(rec.tokenChecks).toEqual([])
    expect(rec.gateChecks).toEqual([])
    await app.close()
  })

  it('suspended -> 503 with Retry-After, no data: no token check, no gate, no event', async () => {
    const w = world()
    w.tenants.set(A_ID, tenantRow(A_ID, 'a', 'suspended'))
    const { app, rec } = appWith(w)
    const res = await app.inject({ url: SELF, headers: edge(A_HOST, 'token-a') })
    expect(res.statusCode).toBe(503)
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.json()).not.toHaveProperty('customerId')
    expect(rec.tokenChecks).toEqual([])
    expect(rec.gateChecks).toEqual([])
    expect(rec.events).toEqual([])
    await app.close()
  })

  it('RED reference ("non-active -> 503"): a deleted customer is 404, never a 503 that confirms it exists', async () => {
    const w = world()
    w.tenants.set(A_ID, tenantRow(A_ID, 'a', 'deleted'))
    const { app } = appWith(w)
    expect((await app.inject({ url: SELF, headers: edge(A_HOST, 'token-a') })).statusCode).not.toBe(503)
    await app.close()
  })

  it('control DB down -> 503 for everyone, not cached: the next request after recovery is served', async () => {
    const w = world()
    w.controlDown = true
    const { app } = appWith(w)
    expect((await app.inject({ url: SELF, headers: edge(A_HOST, 'token-a') })).statusCode).toBe(503)
    expect((await app.inject({ url: SELF, headers: edge(B_HOST, 'token-b') })).statusCode).toBe(503)
    w.controlDown = false
    expect((await app.inject({ url: SELF, headers: edge(A_HOST, 'token-a') })).statusCode).toBe(200)
    await app.close()
  })

  it('Q9: a customer suspended between two requests is refused on the very next one (no status cache)', async () => {
    const w = world()
    const { app } = appWith(w)
    expect((await app.inject({ url: SELF, headers: edge(A_HOST, 'token-a') })).statusCode).toBe(200)
    w.tenants.set(A_ID, tenantRow(A_ID, 'a', 'suspended'))
    expect((await app.inject({ url: SELF, headers: edge(A_HOST, 'token-a') })).statusCode).toBe(503)
    await app.close()
  })
})

describe('boot (Q8)', () => {
  const ENV = {
    TENANT_PROXY_SHARED_SECRET: PROXY_SECRET,
    PLATFORM_DOMAIN: 'example.org',
    KERNEL_API_CONTROL_DB_URL: 'postgres://r:p@db:5432/control',
    KERNEL_API_PLATFORM_DB_URL: 'postgres://r:p@db:5432/gremion_platform',
  }
  const roots = { modulesRoot: '/m', kernelRoot: '/k' }

  it('an unset proxy secret refuses the boot, naming it and no value', () => {
    const { TENANT_PROXY_SHARED_SECRET: _s, ...env } = ENV
    expect(() => readConfig(env, roots)).toThrow(ConfigError)
    expect(() => readConfig(env, roots)).toThrow(/TENANT_PROXY_SHARED_SECRET is not set/)
    expect(() => readConfig({ ...env, TENANT_PROXY_SHARED_SECRET: 'short' }, roots)).toThrow(/shorter than 24/)
    try {
      readConfig({ ...env, KERNEL_API_CONTROL_DB_URL: '' }, roots)
    } catch (err) {
      expect((err as Error).message).not.toMatch(/postgres:\/\//)
    }
  })

  it('a complete environment boots; module secrets are read per module, an empty one means not authorised', () => {
    const c = readConfig({ ...ENV, KERNEL_API_MODULE_SECRET_CALENDAR: 'c'.repeat(32), KERNEL_API_MODULE_SECRET_VAULT: '  ', GREMION_RELEASE_REF: 'dist-v1.2.3' }, roots)
    expect([...c.moduleSecrets.keys()]).toEqual(['calendar'])
    expect(c.releaseRef).toBe('dist-v1.2.3')
    expect(c.port).toBe(3000)
  })

  it('refuses to boot on a non-empty module secret shorter than 24 characters, naming the key and never the value', () => {
    const value = 'tooshort-SECRETVALUE'
    let msg = ''
    try {
      readConfig({ ...ENV, KERNEL_API_MODULE_SECRET_VAULT: value }, roots)
    } catch (err) {
      msg = (err as Error).message
    }
    expect(msg).toMatch(/KERNEL_API_MODULE_SECRET_VAULT is shorter than 24/)
    expect(msg).not.toContain(value)
  })
})
