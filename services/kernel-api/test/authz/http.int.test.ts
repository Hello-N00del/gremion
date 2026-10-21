// The five authz operations through the real Fastify app (spec-first template,
// response contract on) over a real PG18 kernel database: the tenancy hook is
// the in-memory fake of test/harness, the database and RLS are real.
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app/build.ts'
import { APEX, edge, fakeDeps, tenantRow, world } from '../harness/fakes.ts'
import { seedGrant, buildWorld as buildAuthzWorld, type World } from './world.ts'

const HOST = `t.${APEX}`
const NOW = () => Math.floor(Date.now() / 1000)
const SECRET = 'publishing-module-secret-0123456789'
let w: World
let app: FastifyInstance
const claimsOf = new Map<string, Record<string, unknown>>()

beforeAll(async () => {
  w = await buildAuthzWorld('http', undefined, ['admin', 'alice', 'bob'])
  await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.admin!, key: 'body_admin' })
  const fw = world()
  fw.tenants.set(w.db.customerId, tenantRow(w.db.customerId, 'http'))
  fw.domains.set(HOST, w.db.customerId)
  fw.enabled.set(w.db.customerId, ['publishing', 'votes', 'board', 'calendar', 'finance'].map((moduleKey) => ({ moduleKey, semver: '1.0.0' })))
  fw.moduleSecrets.set('publishing', SECRET)
  claimsOf.set('tok-fresh', { sub: 'sub-admin', acr: 'loa2', auth_time: NOW() - 20 })
  claimsOf.set('tok-stale', { sub: 'sub-admin', acr: 'loa2', auth_time: NOW() - 4000 })
  const { deps } = fakeDeps(fw, {
    tokens: { verify: async (token) => claimsOf.get(token) ?? Promise.reject(new Error('bad token')) },
    kernelDb: async () => w.db.app,
  })
  app = buildApp({}, deps)
})
afterAll(async () => {
  await app?.close()
  await w?.db.close()
})

const bearer = (tok: string) => edge(HOST, tok, { 'content-type': 'application/json' })
const post = (url: string, tok: string, payload?: unknown) =>
  app.inject({ method: 'POST', url, headers: payload === undefined ? edge(HOST, tok) : bearer(tok), payload: payload as never })
const issue = (o: Record<string, unknown> = {}) => ({ bodyId: w.bodyA, subjectPersonId: w.persons.alice!, grantKind: 'role', key: 'member', granterRole: 'body_admin', ...o })

describe('authz over HTTP', () => {
  it('decideAuthz (module caller): allow with a granted capability, deny with its reason, a positive 200 either way', async () => {
    const headers = { host: 'kernel-api:3000', 'x-gremion-module': 'publishing', 'x-internal-auth': SECRET, 'x-tenant-id': w.db.customerId, 'content-type': 'application/json' }
    const allow = await app.inject({ method: 'POST', url: '/api/v1/authz/decisions', headers, payload: { subject: 'sub-admin', bodyId: w.bodyA, capability: 'idt.grant.manage' } })
    expect(allow.statusCode).toBe(200)
    expect(allow.json()).toMatchObject({ allow: true, reason: 'granted' })
    const deny = await app.inject({ method: 'POST', url: '/api/v1/authz/decisions', headers, payload: { subject: 'sub-admin', bodyId: w.bodyB, capability: 'idt.grant.manage' } })
    expect(deny.statusCode).toBe(200)
    expect(deny.json()).toEqual({ allow: false, reason: 'no_grant', grantIds: [] })
  })
  it('a bearer person is not a module caller for decideAuthz (no secret -> refused)', async () => {
    const r = await post('/api/v1/authz/decisions', 'tok-fresh', { subject: 'sub-admin', bodyId: w.bodyA, capability: 'idt.grant.manage' })
    expect(r.statusCode).toBe(403)
    expect(r.json().allow).toBeUndefined()
  })
  it('issueAuthzGrant: 201 with the matching granter role; a mismatching one is 403 problem+json', async () => {
    const bad = await post('/api/v1/authz/grants', 'tok-fresh', issue({ granterRole: 'council_admin' }))
    expect(bad.statusCode).toBe(403)
    expect(bad.headers['content-type']).toMatch(/problem\+json/)
    expect(bad.json().type).toBe('urn:gremion:problem:granter-role-mismatch')
    const ok = await post('/api/v1/authz/grants', 'tok-fresh', issue())
    expect(ok.statusCode).toBe(201)
    expect(ok.json()).toMatchObject({ grantKind: 'role', key: 'member', state: 'active', granterKind: 'person', source: 'customer_admin' })
  })
  it('a privileged grant with a stale step-up is 401 with the RFC 9470 challenge', async () => {
    const r = await post('/api/v1/authz/grants', 'tok-stale', issue({ key: 'body_admin', subjectPersonId: w.persons.bob! }))
    expect(r.statusCode).toBe(401)
    expect(String(r.headers['www-authenticate'])).toContain('insufficient_user_authentication')
    expect(String(r.headers['www-authenticate'])).toContain('max_age=300')
  })
  it('listAuthzGrants: the body grants; revoke and revoke-all close them', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/v1/authz/grants?bodyId=${w.bodyA}`, headers: edge(HOST, 'tok-fresh') })
    expect(list.statusCode).toBe(200)
    const grants = list.json().grants as Array<{ grantId: string; subjectPersonId: string; state: string }>
    const aliceGrant = grants.find((g) => g.subjectPersonId === w.persons.alice!)!
    const rev = await post(`/api/v1/authz/grants/${aliceGrant.grantId}/revoke`, 'tok-fresh')
    expect(rev.statusCode).toBe(200)
    expect(rev.json().state).toBe('revoked')
    const again = await post(`/api/v1/authz/grants/${aliceGrant.grantId}/revoke`, 'tok-fresh')
    expect(again.statusCode).toBe(409)
    const all = await post(`/api/v1/authz/persons/${w.persons.admin!}/revoke-all`, 'tok-stale')
    expect(all.statusCode).toBe(401)
  })
})
