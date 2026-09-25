// T1 (route table == spec set), T3 (undeclared path/method -> 404, TRD-406),
// T4 (missing/unknown handler or operationId -> boot error), T8 (response
// schemas stay on; the committed kernel spec's 3.1 constructs load).
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import {
  createService,
  getRouteTable,
  PLATFORM_ROUTES,
  ServiceBootError,
  PROBLEM_CONTENT_TYPE,
  PROBLEM_TYPES,
  type OperationHandler,
} from '../src/index.ts'
import { FIXTURE_ROUTE_KEYS, fixtureHandlers, fixtureSpec, FIXTURE_SPEC_PATH, KERNEL_SPEC_PATH } from './helpers.ts'

const apps: FastifyInstance[] = []
afterEach(async () => {
  while (apps.length) await apps.pop()!.close()
})
function track(app: FastifyInstance): FastifyInstance {
  apps.push(app)
  return app
}

const PLATFORM_KEYS = PLATFORM_ROUTES.map((r) => `${r.method} ${r.path}`)

describe('T1: the route table is loaded from the spec', () => {
  it('registers exactly the fixture spec operations (plus the platform routes), from a parsed document', async () => {
    const app = track(createService({ spec: fixtureSpec(), handlers: fixtureHandlers() }))
    await app.ready()
    expect([...getRouteTable(app)].sort()).toEqual([...FIXTURE_ROUTE_KEYS, ...PLATFORM_KEYS].sort())
  })

  it('accepts the spec as a file path too', async () => {
    const app = track(createService({ spec: FIXTURE_SPEC_PATH, handlers: fixtureHandlers() }))
    await app.ready()
    expect(getRouteTable(app).filter((k) => !PLATFORM_KEYS.includes(k)).sort()).toEqual(FIXTURE_ROUTE_KEYS)
  })

  it('routes a request to the handler named by the operationId, with path params and 2020-12 validation', async () => {
    const app = track(createService({ spec: fixtureSpec(), handlers: fixtureHandlers() }))
    const id = '00000000-0000-4000-8000-00000000abcd'
    const res = await app.inject({ method: 'GET', url: `/widgets/${id}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id, name: 'w', note: null })

    const created = await app.inject({ method: 'POST', url: '/widgets', payload: { name: 'n', note: null } })
    expect(created.statusCode).toBe(201)
    expect(created.json().note).toBeNull() // type: ["string","null"] (3.1) accepted and serialized

    const badFormat = await app.inject({ method: 'GET', url: '/widgets/not-a-uuid' })
    expect(badFormat.statusCode).toBe(400)
    expect(badFormat.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE)
    expect(badFormat.json().type).toBe(PROBLEM_TYPES.validation)

    // additionalProperties:false in the request schema rejects, it does not silently strip
    const extraField = await app.inject({ method: 'POST', url: '/widgets', payload: { name: 'n', sneaky: 1 } })
    expect(extraField.statusCode).toBe(400)

    // a JSON body that is not an integer string is not coerced into one
    const coerced = await app.inject({ method: 'POST', url: '/widgets', payload: { name: 5 } })
    expect(coerced.statusCode).toBe(400)
  })

  it('serves GET /healthz from the template on every service', async () => {
    const app = track(createService({ spec: fixtureSpec(), handlers: fixtureHandlers() }))
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})

describe('T3: undeclared routes are not answered (TRD-406)', () => {
  it('an undeclared path answers 404 problem+json', async () => {
    const app = track(createService({ spec: fixtureSpec(), handlers: fixtureHandlers() }))
    const res = await app.inject({ method: 'GET', url: '/not-in-the-spec' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE)
    expect(res.json()).toMatchObject({ type: PROBLEM_TYPES.notFound, status: 404 })
  })

  it('a declared path with an undeclared method answers 404 or 405', async () => {
    const app = track(createService({ spec: fixtureSpec(), handlers: fixtureHandlers() }))
    for (const [method, url] of [
      ['GET', '/uploads'],
      ['PUT', '/widgets'],
      ['PATCH', '/widgets/00000000-0000-4000-8000-000000000001'],
      ['HEAD', '/widgets'], // no implicit HEAD twin for GET: exposeHeadRoutes is off
    ] as const) {
      const res = await app.inject({ method, url })
      expect([404, 405], `${method} ${url} answered ${res.statusCode}`).toContain(res.statusCode)
    }
  })
})

describe('T4: the handler table must match the spec exactly, or the service does not boot', () => {
  it('a missing handler is a named boot error', () => {
    const handlers = fixtureHandlers()
    delete handlers.getWidget
    expect(() => createService({ spec: fixtureSpec(), handlers })).toThrow(ServiceBootError)
    expect(() => createService({ spec: fixtureSpec(), handlers })).toThrow(/getWidget.*GET \/widgets\/\{widgetId\}/)
  })

  it('a handler for an operationId the spec does not declare is a named boot error', () => {
    const handlers = { ...fixtureHandlers(), notInTheSpec: async () => null }
    expect(() => createService({ spec: fixtureSpec(), handlers })).toThrow(/notInTheSpec/)
  })

  it('an operation without an operationId is a named boot error, not an invented id', () => {
    const spec = fixtureSpec()
    delete spec.paths['/widgets'].get.operationId
    expect(() => createService({ spec, handlers: fixtureHandlers() })).toThrow(/GET \/widgets.*operationId/)
  })

  it('a duplicated operationId is a named boot error', () => {
    const spec = fixtureSpec()
    spec.paths['/widgets'].get.operationId = 'getWidget'
    const handlers = fixtureHandlers()
    delete handlers.listWidgets
    expect(() => createService({ spec, handlers })).toThrow(/duplicate operationId "getWidget"/)
  })

  it('a handler that is not a function is a named boot error', () => {
    const handlers = { ...fixtureHandlers(), listWidgets: 'nope' } as never
    expect(() => createService({ spec: fixtureSpec(), handlers })).toThrow(/listWidgets.*not a function/)
  })

  it('a spec that is not OpenAPI 3.1 is refused', () => {
    const spec = fixtureSpec()
    spec.openapi = '3.0.3'
    expect(() => createService({ spec, handlers: fixtureHandlers() })).toThrow(/3\.1/)
  })

  it('a non-local or dangling $ref is refused', () => {
    const spec = fixtureSpec()
    spec.paths['/widgets'].post.requestBody.content['application/json'].schema = { $ref: '#/components/schemas/Nope' }
    expect(() => createService({ spec, handlers: fixtureHandlers() })).toThrow(/#\/components\/schemas\/Nope/)
    const remote = fixtureSpec()
    remote.paths['/widgets'].post.requestBody.content['application/json'].schema = { $ref: 'other.json#/X' }
    expect(() => createService({ spec: remote, handlers: fixtureHandlers() })).toThrow(/other\.json/)
  })

  it('collects every mapping problem in one error, not just the first', () => {
    const handlers: Record<string, OperationHandler> = { ...fixtureHandlers(), extra1: async () => null }
    delete handlers.listWidgets
    delete handlers.uploadFile
    try {
      createService({ spec: fixtureSpec(), handlers })
      expect.unreachable('createService should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceBootError)
      expect((e as ServiceBootError).problems).toHaveLength(3)
    }
  })
})

describe('T8: response schemas stay on', () => {
  it('serialization drops a field the response schema does not declare', async () => {
    const handlers = fixtureHandlers()
    handlers.getWidget = async (request) => ({
      id: (request.params as { widgetId: string }).widgetId,
      name: 'w',
      note: null,
      passwordHash: 'must-not-leak',
    })
    const app = track(createService({ spec: fixtureSpec(), handlers }))
    const res = await app.inject({ method: 'GET', url: '/widgets/00000000-0000-4000-8000-000000000001' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).not.toHaveProperty('passwordHash')
    expect(res.body).not.toContain('must-not-leak')
  })

  it('a handler response missing a required field fails closed (500 problem), not a partial body', async () => {
    const handlers = fixtureHandlers()
    handlers.getWidget = async () => ({ name: 'no id' })
    const app = track(createService({ spec: fixtureSpec(), handlers }))
    const res = await app.inject({ method: 'GET', url: '/widgets/00000000-0000-4000-8000-000000000001' })
    expect(res.statusCode).toBe(500)
    expect(res.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE)
  })
})

describe('T8: the committed kernel spec (contracts/kernel/openapi.governance.json)', () => {
  const kernel = () => JSON.parse(readFileSync(KERNEL_SPEC_PATH, 'utf8'))

  it('is refused as it stands, because its operations carry no operationId — every one is named', () => {
    const spec = kernel()
    let opCount = 0
    for (const item of Object.values<Record<string, unknown>>(spec.paths)) {
      opCount += Object.keys(item).filter((k) => ['get', 'post', 'put', 'patch', 'delete'].includes(k)).length
    }
    expect(opCount).toBeGreaterThan(0)
    try {
      createService({ spec, handlers: {} })
      expect.unreachable('createService should have thrown')
    } catch (e) {
      const problems = (e as ServiceBootError).problems.filter((p) => p.includes('operationId'))
      expect(problems).toHaveLength(opCount)
    }
  })

  it('loads (Ajv 2020 + its $refs, nullable, formats) once operationIds are present, and the route table matches it', async () => {
    const spec = kernel()
    const handlers: Record<string, () => Promise<null>> = {}
    const expected: string[] = []
    for (const [path, item] of Object.entries<Record<string, Record<string, unknown>>>(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue
        const id = `${method}_${path.replace(/[^A-Za-z0-9]+/g, '_')}`
        op.operationId = id
        handlers[id] = async () => null
        expected.push(`${method.toUpperCase()} ${path}`)
      }
    }
    const app = track(createService({ spec, handlers }))
    await app.ready()
    expect(getRouteTable(app).filter((k) => !PLATFORM_KEYS.includes(k)).sort()).toEqual(expected.sort())
  })
})
