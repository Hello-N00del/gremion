// TDD 1 (routes) and the route-table sweep (lane note C18, R1): the kernel
// API's route table is exactly openapi/kernel-core.json (routes:check's own
// diff, run here against the real app), an added route or a removed operation
// is RED, and the tenancy hook stands in front of EVERY spec route but
// getHealth -- proven by sweeping the table, not by listing routes by hand.
import { describe, expect, it } from 'vitest'
import { checkAppRoutes } from '../../../../packages/fastify-service-template/src/routes-check.ts'
import { createService, getRouteTable, listOperations, loadSpec, notImplemented, routeKey } from '@gremion/fastify-service-template'
import { buildApp, SPEC_URL, TENANT_EXEMPT_OPERATIONS } from '../../src/app/build.ts'
import { unwiredDeps } from '../../src/app/deps.ts'
import { createHandlers } from '../../src/handlers/index.ts'
import { appWith, reads, world } from '../harness/fakes.ts'

const spec = loadSpec(SPEC_URL)
const ops = listOperations(spec)
// TASK-077 core + TASK-080-a bodies; TASK-081 appends its own here, sorted
const ALL_OPERATIONS = ['getBodyTree', 'getHealth', 'getOwnPreference', 'getPerson', 'getTenancySelf', 'listBodyMemberships', 'listBodySeats', 'listEnabledModules', 'listSeatTenures', 'putOwnPreference']

describe('routes (TDD 1)', () => {
  it('the route table equals the spec: 10 operations, nothing else (routes:check)', async () => {
    const app = buildApp()
    const r = await checkAppRoutes(app, spec)
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
    expect(getRouteTable(app).sort()).toEqual(ops.map((o) => routeKey(o.method, o.path)).sort())
    expect(ops.map((o) => o.operationId).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(ALL_OPERATIONS)
    await app.close()
  })

  it('RED: a hand-registered extra route fails routes:check', async () => {
    const app = buildApp()
    app.get('/api/v1/debug', async () => ({}))
    const r = await checkAppRoutes(app, spec)
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/extra route: GET \/api\/v1\/debug/)
    await app.close()
  })

  it('RED: a removed operation (no handler) refuses to boot', () => {
    const { listEnabledModules: _gone, ...handlers } = createHandlers(unwiredDeps())
    expect(() => createService({ spec: SPEC_URL, handlers })).toThrow(/no handler for operationId "listEnabledModules"/)
  })

  it('RED: an operation added to the spec without its handler refuses to boot', () => {
    const grown = structuredClone(spec)
    grown.paths!['/api/v1/extra'] = { get: { operationId: 'getExtra', summary: 'x', responses: { '200': { description: 'x' } } } }
    expect(() => createService({ spec: grown, handlers: createHandlers(unwiredDeps()) })).toThrow(/no handler for operationId "getExtra"/)
    // and with a stub handler the route table grows: routes:check would then diff it against the committed spec
    const app = createService({ spec: grown, handlers: { ...createHandlers(unwiredDeps()), getExtra: notImplemented('getExtra') } })
    expect(getRouteTable(app)).toContain('GET /api/v1/extra')
  })
})

describe('route-table sweep: every spec route but getHealth is tenant-gated (C18)', () => {
  const gated = ops.filter((o) => !TENANT_EXEMPT_OPERATIONS.has(o.operationId!))

  it('covers every tenant operation (not vacuous)', () => {
    expect(gated.map((o) => o.operationId).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(ALL_OPERATIONS.filter((id) => id !== 'getHealth'))
  })

  it.each(gated.map((o) => [o.operationId!, o.method, o.path]))('%s: no proxy proof -> 403 before any read', async (_id, method, path) => {
    const { app, rec } = appWith(world())
    const res = await app.inject({ method: method as 'GET', url: path, headers: { host: 'a.example.org', 'x-forwarded-host': 'a.example.org' } })
    expect(res.statusCode).toBe(403)
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/)
    expect(reads(rec)).toBe(0)
    await app.close()
  })

  it.each(gated.map((o) => [o.operationId!, o.method, o.path]))('%s: unwired (routes:check boot) -> 503 not-configured, nothing read', async (_id, method, path) => {
    const app = buildApp()
    const res = await app.inject({ method: method as 'GET', url: path })
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).type).toBe('urn:gremion:problem:not-configured')
    await app.close()
  })

  it('getHealth answers with no tenant and no headers', async () => {
    const { app, rec } = appWith(world())
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
    expect(reads(rec)).toBe(0)
    await app.close()
  })

  it('an unknown path is the template 404, with no tenant lookup', async () => {
    const { app, rec } = appWith(world())
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope', headers: { host: 'a.example.org' } })
    expect(res.statusCode).toBe(404)
    expect(reads(rec)).toBe(0)
    await app.close()
  })
})
