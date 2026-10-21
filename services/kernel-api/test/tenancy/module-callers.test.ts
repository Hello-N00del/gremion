// TDD 12 (module callers, Q8): gremion-ui leaf-trust's four clauses (B8) as
// the kernel API's check on a module calling back in. Each clause failing
// alone is refused; the RED reference (i) is "module-caller enablement
// ignored": a module not enabled for the customer is 403.
import { describe, expect, it } from 'vitest'
import { createTenancyHook, MODULE_CALLER_OPERATIONS } from '../../src/tenancy/hook.ts'
import { A_ID, appWith, B_ID, fakeDeps, reads, world } from '../harness/fakes.ts'

const SECRET = 'calendar-module-secret-0123456789'

function caller(over: Record<string, string | undefined> = {}): Record<string, string> {
  const h: Record<string, string | undefined> = { host: 'kernel-api-blue:3000', 'x-gremion-module': 'calendar', 'x-internal-auth': SECRET, 'x-tenant-id': A_ID, ...over }
  return Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined)) as Record<string, string>
}

describe('module callers (TDD 12)', () => {
  it('all four clauses hold -> served for the asserted customer, no host and no proxy secret involved', async () => {
    const { app, rec } = appWith(world())
    const res = await app.inject({ url: '/api/v1/modules', headers: caller() })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ customerId: A_ID, modules: [{ moduleKey: 'calendar' }] })
    expect(rec.hostLookups).toEqual([])
    expect(rec.idLookups).toEqual([A_ID])
    await app.close()
  })

  it.each([
    ['a wrong secret', { 'x-internal-auth': `${SECRET}x` }],
    ['no secret', { 'x-internal-auth': undefined }],
    ["another module's secret name", { 'x-gremion-module': 'vault' }],
  ])('%s -> 401, nothing read', async (_n, over) => {
    const { app, rec } = appWith(world())
    const res = await app.inject({ url: '/api/v1/tenancy/self', headers: caller(over) })
    expect(res.statusCode).toBe(401)
    expect(reads(rec)).toBe(0)
    await app.close()
  })

  it.each([
    ['a UUIDv4', '0192f0c1-2b3c-4d4e-8f00-1122334455aa'],
    ['upper case', A_ID.toUpperCase()],
    ['absent', undefined],
    ['a slug', 'a'],
  ])('a non-UUIDv7 tenant (%s) -> 401, nothing read', async (_n, id) => {
    const { app, rec } = appWith(world())
    const res = await app.inject({ url: '/api/v1/tenancy/self', headers: caller({ 'x-tenant-id': id }) })
    expect(res.statusCode).toBe(401)
    expect(reads(rec)).toBe(0)
    await app.close()
  })

  it('RED (i): the module is not enabled for that customer -> 403 (B has no calendar)', async () => {
    const { app, rec } = appWith(world())
    const res = await app.inject({ url: '/api/v1/modules', headers: caller({ 'x-tenant-id': B_ID }) })
    expect(res.statusCode).toBe(403)
    expect(rec.registryReads).toEqual([`is:${B_ID}:calendar`])
    expect(rec.gateChecks).toEqual([])
    await app.close()
  })

  it('an unknown customer id -> 404; a suspended one -> 503; the gate still applies', async () => {
    const w = world()
    const { app } = appWith(w)
    expect((await app.inject({ url: '/api/v1/tenancy/self', headers: caller({ 'x-tenant-id': '0192f0c1-2b3c-7d4e-8f00-ffffffffffff' }) })).statusCode).toBe(404)
    w.verdicts.set(A_ID, { ok: false, reason: 'behind', retryAfterSeconds: 30 })
    expect((await app.inject({ url: '/api/v1/tenancy/self', headers: caller() })).statusCode).toBe(503)
    await app.close()
  })

  it('clause 1: an operation off MODULE_CALLER_OPERATIONS -> 403 before the secret is even compared', async () => {
    expect([...MODULE_CALLER_OPERATIONS].sort()).toEqual(['decideAuthz', 'getTenancySelf', 'listEnabledModules'])
    const { deps, rec } = fakeDeps(world())
    const hook = createTenancyHook(deps, { operationOf: () => 'putBodyMembership', exempt: new Set() })
    let status = 0
    const reply = { code: (s: number) => ((status = s), reply), type: () => reply, header: () => reply, send: () => reply } as never
    await hook({ headers: caller() } as never, reply)
    expect(status).toBe(403)
    expect(reads(rec)).toBe(0)
  })

  it('an unset module secret means no trust for that module, even with an empty header', async () => {
    const w = world()
    w.moduleSecrets.delete('calendar')
    const { app } = appWith(w)
    expect((await app.inject({ url: '/api/v1/tenancy/self', headers: caller({ 'x-internal-auth': '' }) })).statusCode).toBe(401)
    await app.close()
  })
})
