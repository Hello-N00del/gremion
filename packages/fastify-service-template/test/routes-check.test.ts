// T2: routes:check fails closed and names what is wrong: an extra route, a
// spec operation with no route, a duplicate, a 0-operation spec. Only the
// platform allow-list is exempt, and nothing else.
import { describe, it, expect, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createService, PLATFORM_ROUTES } from '../src/index.ts'
import { checkAppRoutes, diffRouteTables } from '../src/routes-check.ts'
import { FIXTURE_ROUTE_KEYS, fixtureHandlers, fixtureSpec } from './helpers.ts'

const apps: FastifyInstance[] = []
afterEach(async () => {
  while (apps.length) await apps.pop()!.close()
})
function build(): FastifyInstance {
  const app = createService({ spec: fixtureSpec(), handlers: fixtureHandlers() })
  apps.push(app)
  return app
}

describe('T2: routes:check on a booted service', () => {
  it('passes when the route table equals the spec (plus platform routes)', async () => {
    const result = await checkAppRoutes(build(), fixtureSpec())
    expect(result.problems).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.declared).toBe(FIXTURE_ROUTE_KEYS.length)
  })

  it('fails on a hand-written extra route, naming it', async () => {
    const app = build()
    app.get('/extra', async () => ({}))
    const result = await checkAppRoutes(app, fixtureSpec())
    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([expect.stringMatching(/^extra route: GET \/extra /)])
  })

  it('fails on an extra route hidden inside a plugin', async () => {
    const app = build()
    app.register(async (child) => {
      child.post('/hidden/:thing', async () => ({}))
    })
    const result = await checkAppRoutes(app, fixtureSpec())
    expect(result.problems).toEqual([expect.stringMatching(/^extra route: POST \/hidden\/\{thing\} /)])
  })

  it('fails on a spec operation with no route, naming it', async () => {
    const declared = fixtureSpec()
    declared.paths['/widgets'].put = { operationId: 'replaceWidgets', responses: { '204': { description: 'x' } } }
    const result = await checkAppRoutes(build(), declared)
    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([expect.stringMatching(/^missing route: PUT \/widgets /)])
  })

  it('fails on a duplicate registration, naming it', async () => {
    // At the root Fastify throws on the spot (routes:check's CLI reports that
    // as a named boot failure); inside a plugin it surfaces at ready(), which
    // is the case checkAppRoutes itself must catch and name.
    expect(() => build().get('/widgets', async () => [])).toThrow(/Method 'GET' already declared for route '\/widgets'/)
    const app = build()
    app.register(async (child) => {
      child.get('/widgets', async () => [])
    })
    const result = await checkAppRoutes(app, fixtureSpec())
    expect(result.ok).toBe(false)
    const text = result.problems.join('\n')
    expect(text).toMatch(/service failed to boot: .*GET.*\/widgets/)
    expect(text).toMatch(/duplicate route registered: GET \/widgets and GET \/widgets/)
  })

  it('fails on a 0-operation spec (vacuity guard)', async () => {
    const empty = fixtureSpec()
    empty.paths = {}
    const result = await checkAppRoutes(build(), empty)
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toMatch(/declares 0 operations/)
  })

  it('exempts exactly the platform routes: a route merely named like one still fails', async () => {
    expect(PLATFORM_ROUTES.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /healthz'])
    const app = build()
    app.post('/healthz', async () => ({}))
    app.get('/healthz/deep', async () => ({}))
    const result = await checkAppRoutes(app, fixtureSpec())
    expect(result.problems).toEqual([
      expect.stringMatching(/^extra route: GET \/healthz\/deep /),
      expect.stringMatching(/^extra route: POST \/healthz /),
    ])
  })
})

describe('T2: diffRouteTables (pure)', () => {
  const declared = ['GET /a', 'POST /a/{id}']

  it('names missing, extra and platform-missing routes together', () => {
    const r = diffRouteTables({ declared, actual: ['GET /a', 'GET /b'] })
    expect(r.problems).toEqual([
      expect.stringMatching(/^missing route: POST \/a\/\{id\}/),
      expect.stringMatching(/^extra route: GET \/b/),
      expect.stringMatching(/^platform route GET \/healthz is not registered/),
    ])
  })

  it('a spec with two templates for one route shape is a duplicate', () => {
    const r = diffRouteTables({ declared: ['GET /a/{id}', 'GET /a/{name}'], actual: ['GET /a/{id}', 'GET /healthz'] })
    expect(r.problems[0]).toMatch(/duplicate route in the spec: GET \/a\/\{id\} and GET \/a\/\{name\}/)
  })

  it('a path parameter renamed in the service is missing + extra, not equal', () => {
    const r = diffRouteTables({ declared: ['GET /a/{id}'], actual: ['GET /a/{key}', 'GET /healthz'] })
    expect(r.ok).toBe(false)
    expect(r.problems).toHaveLength(2)
  })

  it('an empty actual table against a non-empty spec fails', () => {
    expect(diffRouteTables({ declared, actual: [] }).ok).toBe(false)
  })
})
