// TASK-081 G3: the PDP bound to the identity domain service's WriteAuthorizer seam,
// over a real PG18 kernel database made by the shipped chain (core, bodies, authz).
// A granted body_admin can create an org unit in ITS body; every other person-token
// write is refused (default deny holds wherever decide() says no) and a refusal
// writes nothing: no row, no outbox event.
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app/build.ts'
import { pdpWriteAuthorizer } from '../../src/authz/write-authorizer.ts'
import { BodiesError } from '../../src/bodies/errors.ts'
import { createBodiesService } from '../../src/bodies/service.ts'
import { APEX, edge, fakeDeps, tenantRow, world } from '../harness/fakes.ts'
import { buildWorld, makeRegistry, seedGrant, type World } from './world.ts'
import { uuidv7 } from './db.ts'

let w: World
const reg = makeRegistry(['publishing', 'votes', 'board', 'calendar', 'finance'])
const svc = () => createBodiesService({ authorizer: pdpWriteAuthorizer(reg.read) })
const ctxOf = (person: string) => ({ sql: w.db.app, customerId: w.db.customerId, actor: { kind: 'person' as const, id: w.persons[person]! } })
const counts = async () => {
  const [r] = await w.db.admin<{ units: number; bodies: number; persons: number; outbox: number }[]>`
    SELECT (SELECT count(*)::int FROM idt.org_unit) AS units, (SELECT count(*)::int FROM idt.body) AS bodies,
           (SELECT count(*)::int FROM idt.person) AS persons, (SELECT count(*)::int FROM idt.outbox) AS outbox`
  return r!
}
const refused = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(BodiesError)
  expect((err as BodiesError).code).toBe('FORBIDDEN')
}

beforeAll(async () => {
  w = await buildWorld('writeauth', undefined, ['alice', 'bob', 'carol', 'dave', 'erin', 'ca', 'it', 'zed'])
  const g = (person: string, bodyId: string, key: string) => seedGrant(w.db.admin, w.db.customerId, { bodyId, personId: w.persons[person]!, key })
  await g('alice', w.bodyA, 'body_admin')
  await g('carol', w.bodyA, 'member')
  await g('ca', w.verwaltung, 'council_admin')
  await g('it', w.verwaltung, 'it_admin')
  await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.bob!, key: 'body_admin', validFrom: new Date(Date.now() - 7200_000).toISOString(), validUntil: new Date(Date.now() - 3600_000).toISOString() })
  await g('dave', w.bodyA, 'body_admin')
  await w.db.admin`UPDATE idt.authz_grant SET state = 'revoked', revoked_at = now(), revoke_reason = 'manual', revoked_by_kind = 'system' WHERE subject_person_id = ${w.persons.dave}::uuid`
}, 120_000)
afterAll(async () => {
  await w?.db.close()
})

describe('G3: a granted body_admin can create an org unit', () => {
  it('in the body it holds the role in: the unit exists, attributed to that person, and its event is queued', async () => {
    const before = await counts()
    const out = await svc().createOrgUnit(ctxOf('alice'), { bodyId: w.bodyA, kindKey: 'council', name: 'Rat A' })
    const [u] = await w.db.admin<{ body_id: string; created_by_kind: string; created_by: string }[]>`SELECT body_id::text, created_by_kind, created_by::text FROM idt.org_unit WHERE org_unit_id = ${out.orgUnitId}::uuid`
    expect(u).toEqual({ body_id: w.bodyA, created_by_kind: 'person', created_by: w.persons.alice })
    expect(await counts()).toEqual({ ...before, units: before.units + 1, outbox: before.outbox + 1 })
  })

  it('and only there: the same role in body A does not reach body B (TRD-429), and nothing is written', async () => {
    const before = await counts()
    await refused(svc().createOrgUnit(ctxOf('alice'), { bodyId: w.bodyB, kindKey: 'council', name: 'Rat B' }))
    expect(await counts()).toEqual(before)
  })
})

describe('G3: default deny holds wherever the PDP says no, and a refusal writes nothing', () => {
  it.each([
    ['a person with no grant', 'zed'],
    ['a person holding only the member role (no structure capability)', 'carol'],
    ['a body_admin whose grant has expired', 'bob'],
    ['a body_admin whose grant was revoked', 'dave'],
  ])('%s: createOrgUnit is FORBIDDEN', async (_why, person) => {
    const before = await counts()
    await refused(svc().createOrgUnit(ctxOf(person), { bodyId: w.bodyA, kindKey: 'council', name: 'Rat X' }))
    expect(await counts()).toEqual(before)
  })

  it('a customer-level write is decided in the verwaltung: a body_admin may not invite a person, a council_admin / it_admin held there may', async () => {
    const before = await counts()
    await refused(svc().invitePerson(ctxOf('alice'), { email: 'x1@example.test', displayName: 'X One' }))
    expect(await counts()).toEqual(before)
    await svc().invitePerson(ctxOf('ca'), { email: 'x2@example.test', displayName: 'X Two' })
    await svc().invitePerson(ctxOf('it'), { email: 'x3@example.test', displayName: 'X Three' })
    expect(await counts()).toMatchObject({ persons: before.persons + 2, outbox: before.outbox + 2 })
  })

  it('a top-level body needs structure authority in the verwaltung: council_admin yes, it_admin no, body_admin no', async () => {
    const before = await counts()
    await refused(svc().createBody(ctxOf('it'), { kindKey: 'initiative', name: 'Initiative It' }))
    await refused(svc().createBody(ctxOf('alice'), { kindKey: 'initiative', name: 'Initiative Alice' }))
    expect(await counts()).toEqual(before)
    await svc().createBody(ctxOf('ca'), { kindKey: 'initiative', name: 'Initiative CA' })
    expect(await counts()).toMatchObject({ bodies: before.bodies + 1, outbox: before.outbox + 1 })
  })

  it('a grant is read at decision time: the write that was allowed is refused once the grant is revoked', async () => {
    const grantId = await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.erin!, key: 'body_admin' })
    await svc().createOrgUnit(ctxOf('erin'), { bodyId: w.bodyA, kindKey: 'council', name: 'Rat Erin' })
    await w.db.admin`UPDATE idt.authz_grant SET state = 'revoked', revoked_at = now(), revoke_reason = 'manual', revoked_by_kind = 'system' WHERE grant_id = ${grantId}::uuid`
    const before = await counts()
    await refused(svc().createOrgUnit(ctxOf('erin'), { bodyId: w.bodyA, kindKey: 'council', name: 'Rat Late' }))
    expect(await counts()).toEqual(before)
  })

  it('an operator actor is not the PDP\'s to authorize (it uses operatorAuthorizer, not this one)', async () => {
    const before = await counts()
    await refused(svc().createOrgUnit({ sql: w.db.app, customerId: w.db.customerId, actor: { kind: 'operator', id: uuidv7() } }, { bodyId: w.bodyA, kindKey: 'council', name: 'Rat Op' }))
    expect(await counts()).toEqual(before)
  })
})

describe('G3 over HTTP: a person token writes only with a grant', () => {
  const HOST = `t.${APEX}`
  let app: FastifyInstance
  const tokens = new Map<string, Record<string, unknown>>([
    ['tok-zed', { sub: 'sub-zed' }],
    ['tok-ca', { sub: 'sub-ca' }],
  ])
  beforeAll(async () => {
    const fw = world()
    fw.tenants.set(w.db.customerId, tenantRow(w.db.customerId, 'writeauth'))
    fw.domains.set(HOST, w.db.customerId)
    const { deps } = fakeDeps(fw, {
      tokens: { verify: async (token) => tokens.get(token) ?? Promise.reject(new Error('bad token')) },
      tenantDb: { sqlFor: async () => w.db.app },
      authorizer: pdpWriteAuthorizer(reg.read),
    })
    app = buildApp({}, deps)
  })
  afterAll(async () => {
    await app?.close()
  })
  const create = (tok: string, name: string) =>
    app.inject({ method: 'POST', url: '/api/v1/bodies', headers: edge(HOST, tok, { 'content-type': 'application/json' }), payload: { kindKey: 'initiative', name } })

  it('an ungranted person-token write is 403 problem+json and writes nothing', async () => {
    const before = await counts()
    const r = await create('tok-zed', 'Initiative Zed')
    expect(r.statusCode).toBe(403)
    expect(r.headers['content-type']).toMatch(/problem\+json/)
    expect(await counts()).toEqual(before)
  })

  it('the same write by a person granted council_admin in the verwaltung is 201 and creates the body', async () => {
    const before = await counts()
    const r = await create('tok-ca', 'Initiative Http')
    expect(r.statusCode, r.body).toBe(201)
    const [b] = await w.db.admin<{ name: string; created_by: string }[]>`SELECT name, created_by::text FROM idt.body WHERE body_id = ${r.json().id}::uuid`
    expect(b).toEqual({ name: 'Initiative Http', created_by: w.persons.ca })
    expect(await counts()).toMatchObject({ bodies: before.bodies + 1 })
  })
})
