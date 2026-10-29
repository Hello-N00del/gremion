import { describe, expect, it } from 'vitest'
import { AuthzClientError, createAuthzClient } from '../src/index.ts'

const C = '0192f0c1-2b3c-7d4e-8f00-1122334455aa'
const B = '0192f0c1-2b3c-7d4e-8f00-1122334455bb'
const mk = (f: typeof fetch) => createAuthzClient({ baseUrl: 'http://kernel-api:3000', moduleKey: 'publishing', secret: 's'.repeat(32), fetch: f })
const ok = (b: unknown, status = 200) => (async () => new Response(JSON.stringify(b), { status })) as unknown as typeof fetch

describe('authz client', () => {
  it('posts the decision as a module caller and returns the kernel answer', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const c = mk((async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response(JSON.stringify({ allow: true, reason: 'granted', grantIds: ['g1'] }), { status: 200 })
    }) as unknown as typeof fetch)
    const d = await c.decide({ customerId: C, subject: 'sub-1', bodyId: B, capability: 'newsletter.send' })
    expect(d).toEqual({ allow: true, reason: 'granted', grantIds: ['g1'] })
    expect(seen!.url).toBe('http://kernel-api:3000/api/v1/authz/decisions')
    const h = seen!.init.headers as Record<string, string>
    expect(h['x-gremion-module']).toBe('publishing')
    expect(h['x-tenant-id']).toBe(C)
    expect(h['x-internal-auth']).toHaveLength(32)
  })
  it('fails closed: non-200, malformed body and transport errors throw (callers treat a throw as deny)', async () => {
    await expect(mk(ok({}, 403)).decide({ customerId: C, subject: 's', bodyId: B, capability: 'x.y' })).rejects.toBeInstanceOf(AuthzClientError)
    await expect(mk(ok({ allow: 'yes' })).decide({ customerId: C, subject: 's', bodyId: B, capability: 'x.y' })).rejects.toThrow(/malformed/)
    await expect(mk((async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch).decide({ customerId: C, subject: 's', bodyId: B, capability: 'x.y' })).rejects.toThrow(/ECONNREFUSED/)
  })
  it('refuses a non-uuid customer or body before any call', async () => {
    let called = false
    const c = mk((async () => { called = true; return new Response('{}') }) as unknown as typeof fetch)
    await expect(c.decide({ customerId: 'a', subject: 's', bodyId: B, capability: 'x.y' })).rejects.toBeInstanceOf(AuthzClientError)
    expect(called).toBe(false)
  })
  it('never caches: two identical calls make two requests', async () => {
    let n = 0
    const c = mk((async () => { n++; return new Response(JSON.stringify({ allow: false, reason: 'module_not_enabled', grantIds: [] })) }) as unknown as typeof fetch)
    await c.decide({ customerId: C, subject: 's', bodyId: B, capability: 'newsletter.send' })
    await c.decide({ customerId: C, subject: 's', bodyId: B, capability: 'newsletter.send' })
    expect(n).toBe(2)
  })
})
