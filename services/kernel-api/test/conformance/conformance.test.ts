// TDD 10 (undeclared field) and the P1 black-box conformance suite (Q13 /
// lane note A5: it satisfies "L2's conformance kit passes" at P1; TASK-078
// re-runs its kit in P2): every response the kernel API gives -- success and
// problem alike -- is declared by openapi/kernel-core.json for that operation
// and status, and its body validates; two customers route to themselves. A
// seeded undeclared field is a 500 response-contract-violation, never a
// silent drop (RED reference: the template's default drops it).
import { createService, inlineRefs, listOperations, loadSpec } from '@gremion/fastify-service-template'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { describe, expect, it } from 'vitest'
import { SPEC_URL } from '../../src/app/build.ts'
import { buildResponseContract, checkResponse, RESPONSE_CONTRACT_VIOLATION } from '../../src/app/response-contract.ts'
import { createHandlers } from '../../src/handlers/index.ts'
import { setContext } from '../../src/tenancy/context.ts'
import { A_HOST, A_ID, appWith, B_HOST, B_ID, DECL, edge, fakeDeps, PROXY_SECRET, tenantRow, world } from '../harness/fakes.ts'

const doc = inlineRefs(loadSpec(SPEC_URL))
const contract = buildResponseContract(doc)
const opByPath = new Map(listOperations(doc).map((o) => [`${o.method} ${o.path}`, o.operationId!]))

/** Asserts one response is what the spec declares for its operation and status; returns the parsed body. */
function conforms(method: string, path: string, res: LightMyRequestResponse): unknown {
  const op = opByPath.get(`${method} ${path}`)!
  const mediaType = String(res.headers['content-type'] ?? '').split(';')[0]!.trim()
  const body = JSON.parse(res.body)
  const v = checkResponse(contract, op, res.statusCode, mediaType, body)
  expect(v, `${op} ${res.statusCode} ${mediaType}: ${JSON.stringify(v?.problems)}`).toBeNull()
  return body
}

describe('black-box conformance (Q13, P1)', () => {
  const cases: Array<[string, string, Record<string, string>, (w: ReturnType<typeof world>) => void]> = [
    ['200 self', '/api/v1/tenancy/self', edge(A_HOST, 'token-a'), () => {}],
    ['200 modules', '/api/v1/modules', edge(A_HOST, 'token-a'), () => {}],
    ['401', '/api/v1/tenancy/self', edge(A_HOST, 'token-b'), () => {}],
    ['403', '/api/v1/modules', { host: A_HOST, 'x-forwarded-host': A_HOST }, () => {}],
    ['404', '/api/v1/tenancy/self', edge('nobody.example', 'token-a'), () => {}],
    ['503 suspended', '/api/v1/modules', edge(A_HOST, 'token-a'), (w) => w.tenants.set(A_ID, tenantRow(A_ID, 'a', 'suspended'))],
    ['503 behind', '/api/v1/tenancy/self', edge(A_HOST, 'token-a'), (w) => w.verdicts.set(A_ID, { ok: false, reason: 'behind', retryAfterSeconds: 30 })],
    ['503 registry', '/api/v1/tenancy/self', edge(A_HOST, 'token-a'), (w) => (w.controlDown = true)],
  ]

  it.each(cases)('%s: declared status, declared media type, body validates', async (_n, url, headers, setup) => {
    const w = world()
    setup(w)
    const { app } = appWith(w)
    const res = await app.inject({ url, headers })
    conforms('GET', url, res)
    if (res.statusCode === 503) expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    await app.close()
  })

  it('getHealth conforms', async () => {
    const { app } = appWith(world())
    expect(conforms('GET', '/healthz', await app.inject({ url: '/healthz' }))).toEqual({ status: 'ok' })
    await app.close()
  })

  it('two-tenant routing: A host -> A only, B host -> B only, on one app, interleaved', async () => {
    const { app } = appWith(world())
    for (const [host, token, id] of [
      [A_HOST, 'token-a', A_ID],
      [B_HOST, 'token-b', B_ID],
      [A_HOST, 'token-a', A_ID],
    ] as const) {
      const body = conforms('GET', '/api/v1/tenancy/self', await app.inject({ url: '/api/v1/tenancy/self', headers: edge(host, token) })) as { customerId: string }
      expect(body.customerId).toBe(id)
    }
    await app.close()
  })

  it('the suite is not vacuous: every spec operation was exercised', () => {
    // the ten `bodies` operations (TASK-080-a) are exercised in test/bodies/http.test.ts, which asserts the same set
    expect(new Set(opByPath.values())).toEqual(
      new Set(['createBody', 'getBodyTree', 'getHealth', 'getOwnPreference', 'getPerson', 'getTenancySelf', 'invitePerson', 'listBodyMemberships', 'listBodySeats', 'listEnabledModules', 'listSeatTenures', 'putOwnPreference', 'startMembership']),
    )
    expect(cases.length).toBeGreaterThanOrEqual(8)
  })
})

describe('undeclared field (TDD 10, Q4)', () => {
  it('a seeded undeclared field -> 500 response-contract-violation, the path logged, the field never sent', async () => {
    const w = world()
    w.declarations.set('calendar', { ...DECL, internalSecretPath: '/run/secrets/x' } as never)
    const { app, rec } = appWith(w)
    const res = await app.inject({ url: '/api/v1/modules', headers: edge(A_HOST, 'token-a') })
    expect(res.statusCode).toBe(500)
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/)
    expect(res.json()).toEqual({ type: RESPONSE_CONTRACT_VIOLATION, title: 'Internal Server Error', status: 500, detail: 'The response did not match the API contract.' })
    expect(res.body).not.toMatch(/internalSecretPath|run\/secrets/)
    const logged = rec.logs.find((l) => l.msg === 'response-contract-violation')
    expect(logged?.fields).toMatchObject({ operationId: 'listEnabledModules', status: 200 })
    expect(JSON.stringify(logged?.fields)).toMatch(/internalSecretPath/)
    await app.close()
  })

  it('a wrong type is a violation too (customerId not a UUIDv7)', () => {
    expect(checkResponse(contract, 'getTenancySelf', 200, 'application/json', { customerId: 'nope', slug: 'a', realm: 'r' })?.problems.join()).toMatch(/customerId/)
    expect(checkResponse(contract, 'getTenancySelf', 201, 'application/json', {})?.problems.join()).toMatch(/no application\/json body is declared for status 201/)
  })

  it('RED reference: the template default (no contract hook) silently DROPS the field and answers 200', async () => {
    const w = world()
    w.declarations.set('calendar', { ...DECL, internalSecretPath: '/run/secrets/x' } as never)
    const { deps } = fakeDeps(w)
    const handlers = createHandlers(deps)
    const plain: FastifyInstance = createService({ spec: SPEC_URL, handlers })
    plain.addHook('onRequest', async (request) => setContext(request, { tenant: w.tenants.get(A_ID)!, caller: { kind: 'user', claims: {} } }))
    const res = await plain.inject({ url: '/api/v1/modules', headers: { 'x-proxy-trust': PROXY_SECRET } })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toMatch(/internalSecretPath/)
    await plain.close()
  })
})
