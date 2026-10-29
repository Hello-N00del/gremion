// TASK-080-a step c: the `bodies` operations over the REAL app (tenancy
// hook, response contract) with a scripted tenant database. What is held here:
//   * every response conforms to openapi/kernel-core.json (status, media type, body);
//   * personal data is served to the person themself only (own 200, other 403,
//     a subject with no person 403, a module caller 403 before any handler);
//   * no HTTP write exists but the own preference (the spec holds no other
//     non-GET operation of the bodies tag);
//   * TRD-082: every query the handlers issue carries the customer id, the
//     body-scoped ones the body id (a seeded unscoped query turns the check RED).
import { inlineRefs, listOperations, loadSpec } from '@gremion/fastify-service-template'
import type { Sql } from '@gremion/db'
import { describe, expect, it } from 'vitest'
import { SPEC_URL } from '../../src/app/build.ts'
import { buildResponseContract, checkResponse } from '../../src/app/response-contract.ts'
import { A_HOST, A_ID, appWith, edge, world } from '../harness/fakes.ts'
import { normalise, scopeProblems, type RecordedQuery } from '../harness/query-recorder.ts'

const doc = inlineRefs(loadSpec(SPEC_URL))
const contract = buildResponseContract(doc)
const U = (n: number) => `0192f0c1-2b3c-7d4e-8f00-00000000${String(n).padStart(4, '0')}`
const BODY = U(1)
const SEAT = U(2)
const PERSON = U(3)
const NOW = new Date('2026-10-29T10:00:00Z')

type Answer = (text: string, params: unknown[]) => unknown[] | undefined

/** A scripted tenant Sql: `begin` hands the handler a recording tx whose rows come from `answer` (first match wins). */
function scripted(records: RecordedQuery[], answer: Answer): Sql {
  const tx = (strings: TemplateStringsArray, ...params: unknown[]) => {
    const text = normalise(strings.map((s, i) => (i === 0 ? s : `$${i}${s}`)).join(''))
    records.push({ text, params })
    if (text.startsWith('SELECT set_config')) return Promise.resolve([{ set_config: params[0] }])
    const rows = answer(text, params)
    if (!rows) throw new Error(`unscripted query: ${text}`)
    return Promise.resolve(rows)
  }
  const sql = Object.assign(tx, { begin: async (fn: (t: unknown) => Promise<unknown>) => fn(tx), end: async () => {} })
  return sql as unknown as Sql
}

const rowsFor: Answer = (text, params) => {
  if (text.includes('FROM idt.body WHERE customer_id') && text.includes('ORDER BY name')) {
    return [{ body_id: BODY, kind_key: 'stura', name: 'Studierendenrat', short_name: 'StuRa', parent_body_id: null, state: 'active', archived_at: null, row_version: 1 }]
  }
  if (text.includes('FROM idt.org_unit u JOIN idt.org_unit_kind')) {
    return [{ org_unit_id: U(4), body_id: BODY, parent_org_unit_id: null, kind_key: 'council', name: 'Plenum', is_organ: true, state: 'active', row_version: 1 }]
  }
  if (text.startsWith('SELECT body_id FROM idt.body')) return params.includes(BODY) ? [{ body_id: BODY }] : []
  if (text.startsWith('SELECT seat_id FROM idt.seat')) return params.includes(SEAT) ? [{ seat_id: SEAT }] : []
  if (text.includes('FROM idt.seat WHERE customer_id')) {
    return [{ seat_id: SEAT, body_id: BODY, org_unit_id: null, title: 'Vorsitz', seat_kind: 'office', fill_mode: 'direct_election', holder_cardinality: 'single', voting: true, state: 'active' }]
  }
  if (text.includes('FROM idt.tenure WHERE customer_id') && text.includes('ended_on IS NULL')) {
    return [{ tenure_id: U(5), seat_id: SEAT, person_id: PERSON, starts_on: '2026-04-01', planned_end_on: null }]
  }
  if (text.includes('FROM idt.tenure WHERE customer_id')) {
    return [{ tenure_id: U(5), person_id: PERSON, wahlperiode_id: null, starts_on: '2026-04-01', planned_end_on: null, ended_on: null, end_reason: null, source: 'election' }]
  }
  if (text.includes('FROM idt.membership')) {
    return [{ membership_id: U(6), person_id: PERSON, org_unit_id: null, participation_kind: 'elected_member', voting: true, valid_from: '2026-04-01', valid_until: null, wahlperiode_id: null, end_reason: null, source: 'admin' }]
  }
  if (text.includes('FROM idt.person WHERE customer_id') && text.includes('person_id = $')) {
    return params.includes('person-1') && params.includes(PERSON)
      ? [{ person_id: PERSON, display_name: 'Ada', email: 'ada@example.org', account_state: 'active', pseudonym: 'p_x', invited_at: NOW, activated_at: NOW }]
      : []
  }
  if (text.includes('SELECT person_id FROM idt.person WHERE customer_id')) return params.includes('person-1') ? [{ person_id: PERSON }] : []
  if (text.includes('FROM idt.preference')) {
    return [{ locale: 'follow_customer', display_density: 'standard', colour_scheme: 'system', last_body_id: null, row_version: 1, updated_by_kind: 'person', updated_by: PERSON }]
  }
  if (text.includes('FROM idt.customer_setting')) return [{ default_locale: 'de' }]
  if (text.startsWith('INSERT INTO idt.preference')) return []
  return undefined
}

function setup(answer: Answer = rowsFor) {
  const records: RecordedQuery[] = []
  const w = world()
  const { app } = appWith(w, { tenantDb: { sqlFor: async () => scripted(records, answer) } })
  return { app, records }
}

async function get(app: ReturnType<typeof setup>['app'], url: string, method: 'GET' | 'PUT' | 'POST' = 'GET', payload?: unknown, headers = edge(A_HOST, 'token-a')) {
  const res = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const op = res.headers['x-op']
  void op
  return res
}

const exercised = new Set<string>()
function conforms(operationId: string, res: Awaited<ReturnType<typeof get>>): unknown {
  exercised.add(operationId)
  const mediaType = String(res.headers['content-type'] ?? '').split(';')[0]!.trim()
  const body = JSON.parse(res.body)
  const v = checkResponse(contract, operationId, res.statusCode, mediaType, body)
  expect(v, `${operationId} ${res.statusCode}: ${JSON.stringify(v?.problems)} ${res.body}`).toBeNull()
  return body
}

describe('the bodies operations (TASK-080-a step c)', () => {
  it('getBodyTree: 200, the bodies and org units of the customer, conforming', async () => {
    const { app } = setup()
    const res = await get(app, '/api/v1/bodies/tree')
    expect(res.statusCode).toBe(200)
    const body = conforms('getBodyTree', res) as { bodies: unknown[]; orgUnits: unknown[] }
    expect(body.bodies).toHaveLength(1)
    expect(body.orgUnits).toHaveLength(1)
    await app.close()
  })

  it('listBodySeats: 200 with the current holders; an unknown body is 404', async () => {
    const { app } = setup()
    const ok = await get(app, `/api/v1/bodies/${BODY}/seats`)
    expect(ok.statusCode).toBe(200)
    const body = conforms('listBodySeats', ok) as { seats: Array<{ holders: unknown[] }> }
    expect(body.seats[0]!.holders).toHaveLength(1)
    const missing = await get(app, `/api/v1/bodies/${U(99)}/seats`)
    expect(missing.statusCode).toBe(404)
    conforms('listBodySeats', missing)
    await app.close()
  })

  it('listSeatTenures: 200, the history; an unknown seat is 404', async () => {
    const { app } = setup()
    const ok = await get(app, `/api/v1/seats/${SEAT}/tenures`)
    expect(ok.statusCode).toBe(200)
    expect((conforms('listSeatTenures', ok) as { tenures: unknown[] }).tenures).toHaveLength(1)
    const missing = await get(app, `/api/v1/seats/${U(98)}/tenures`)
    expect(missing.statusCode).toBe(404)
    await app.close()
  })

  it('listBodyMemberships: 200 for a day (asOf), the person by id only; a malformed day is 400', async () => {
    const { app } = setup()
    const ok = await get(app, `/api/v1/bodies/${BODY}/memberships?asOf=2026-06-01`)
    expect(ok.statusCode).toBe(200)
    const body = conforms('listBodyMemberships', ok) as { asOf: string; memberships: Array<Record<string, unknown>> }
    expect(body.asOf).toBe('2026-06-01')
    expect(Object.keys(body.memberships[0]!)).not.toEqual(expect.arrayContaining(['displayName', 'email']))
    const bad = await get(app, `/api/v1/bodies/${BODY}/memberships?asOf=yesterday`)
    expect(bad.statusCode).toBe(400)
    await app.close()
  })

  it('getPerson: the signed-in person\'s own record is 200; another person\'s record is 403 (never 404)', async () => {
    const { app } = setup()
    const own = await get(app, `/api/v1/persons/${PERSON}`)
    expect(own.statusCode).toBe(200)
    expect((conforms('getPerson', own) as { email: string }).email).toBe('ada@example.org')
    const other = await get(app, `/api/v1/persons/${U(77)}`)
    expect(other.statusCode).toBe(403)
    conforms('getPerson', other)
    await app.close()
  })

  it('own preference: GET 200 through the verified subject; PUT saves (200); an empty body or an unknown value is 400', async () => {
    const { app } = setup()
    const got = await get(app, '/api/v1/persons/me/preference')
    expect(got.statusCode).toBe(200)
    expect(conforms('getOwnPreference', got)).toMatchObject({ personId: PERSON, locale: 'follow_customer', effectiveLocale: 'de' })
    const put = await get(app, '/api/v1/persons/me/preference', 'PUT', { locale: 'en' })
    expect(put.statusCode).toBe(200)
    conforms('putOwnPreference', put)
    expect((await get(app, '/api/v1/persons/me/preference', 'PUT', {})).statusCode).toBe(400)
    expect((await get(app, '/api/v1/persons/me/preference', 'PUT', { locale: 'xx' })).statusCode).toBe(400)
    expect((await get(app, '/api/v1/persons/me/preference', 'PUT', { personId: PERSON, locale: 'de' })).statusCode).toBe(400) // no way to name another person
    await app.close()
  })

  it('a token whose subject belongs to no active person: 403 on the own preference (read and write), nothing written', async () => {
    const records: RecordedQuery[] = []
    const w = world()
    const { app } = appWith(w, {
      tenantDb: { sqlFor: async () => scripted(records, (t, p) => (t.includes('SELECT person_id FROM idt.person') ? [] : rowsFor(t, p))) },
    })
    const got = await get(app, '/api/v1/persons/me/preference')
    expect(got.statusCode).toBe(403)
    const put = await get(app, '/api/v1/persons/me/preference', 'PUT', { locale: 'en' })
    expect(put.statusCode).toBe(403)
    expect(records.some((r) => r.text.startsWith('INSERT'))).toBe(false)
    await app.close()
  })

  it('a module caller is refused 403 on every bodies operation before a handler runs (none is on MODULE_CALLER_OPERATIONS)', async () => {
    const records: RecordedQuery[] = []
    const w = world()
    const { app } = appWith(w, { tenantDb: { sqlFor: async () => scripted(records, rowsFor) } })
    const headers = { 'x-gremion-module': 'calendar', 'x-internal-auth': 'calendar-module-secret-0123456789', 'x-tenant-id': A_ID }
    for (const url of ['/api/v1/bodies/tree', `/api/v1/bodies/${BODY}/seats`, `/api/v1/seats/${SEAT}/tenures`, `/api/v1/persons/me/preference`, `/api/v1/persons/${PERSON}`]) {
      expect((await get(app, url, 'GET', undefined, headers as never)).statusCode, url).toBe(403)
    }
    expect(records).toHaveLength(0)
    await app.close()
  })

  it('the HTTP writes of the bodies tag are the own preference and three person writes; everything else has no route', async () => {
    const writes = listOperations(doc).filter((o) => (o.operation as { tags?: string[] }).tags?.includes('bodies') && o.method !== 'GET')
    expect(writes.map((o) => o.operationId).sort()).toEqual(['createBody', 'invitePerson', 'putOwnPreference', 'startMembership'])
    const { app } = setup()
    for (const [method, url] of [['PUT', `/api/v1/bodies/${BODY}`], ['DELETE', `/api/v1/bodies/${BODY}`], ['DELETE', `/api/v1/persons/${PERSON}`], ['POST', `/api/v1/seats`]] as const) {
      const res = await app.inject({ method, url, headers: edge(A_HOST, 'token-a'), payload: {} })
      expect([404, 405], `${method} ${url}`).toContain(res.statusCode)
    }
    await app.close()
  })

  it('A3 / guard 6: under the shipped authorizer (deny all) a person-token write is 403 and NOTHING is written (no INSERT, no outbox row); a malformed body is 400 before that', async () => {
    const { app, records } = setup()
    const create = await get(app, '/api/v1/bodies', 'POST', { kindKey: 'stura', name: 'Studierendenrat' })
    expect(create.statusCode).toBe(403)
    conforms('createBody', create)
    const invite = await get(app, '/api/v1/persons', 'POST', { email: 'x@example.org', displayName: 'X' })
    expect(invite.statusCode).toBe(403)
    conforms('invitePerson', invite)
    const member = await get(app, `/api/v1/bodies/${BODY}/memberships`, 'POST', { personId: PERSON, participationKind: 'elected_member', voting: true, validFrom: '2026-04-01' })
    expect(member.statusCode).toBe(403)
    conforms('startMembership', member)
    expect(records.filter((r) => /^(INSERT|UPDATE|DELETE)/.test(r.text))).toEqual([])
    expect((await get(app, '/api/v1/bodies', 'POST', { kindKey: 'stura' })).statusCode).toBe(400) // name missing
    expect((await get(app, '/api/v1/bodies', 'POST', { kindKey: 'stura', name: 'N', customerId: A_ID })).statusCode).toBe(400) // no way to name a customer
    // a token with no active person is refused before the authorizer is even asked
    const none = setup((t, p) => (t.includes('SELECT person_id FROM idt.person') ? [] : rowsFor(t, p)))
    expect((await get(none.app, '/api/v1/bodies', 'POST', { kindKey: 'stura', name: 'N' })).statusCode).toBe(403)
    await app.close()
    await none.app.close()
  })

  it('TRD-082: every query carries the customer id, the body-scoped ones the body id; a seeded unscoped query is RED', async () => {
    const { app, records } = setup()
    await get(app, '/api/v1/bodies/tree')
    await get(app, `/api/v1/bodies/${BODY}/seats`)
    await get(app, `/api/v1/bodies/${BODY}/memberships`)
    await get(app, `/api/v1/seats/${SEAT}/tenures`)
    await get(app, `/api/v1/persons/${PERSON}`)
    await get(app, '/api/v1/persons/me/preference')
    await get(app, '/api/v1/persons/me/preference', 'PUT', { locale: 'en' })
    expect(scopeProblems(records, [A_ID], [])).toEqual([])
    const bodyScoped = records.filter((r) => /idt\.(seat|membership) WHERE/.test(r.text) && r.text.includes('body_id = $'))
    expect(bodyScoped.length).toBeGreaterThanOrEqual(2)
    for (const q of bodyScoped) expect(q.params).toContain(BODY)
    // RED reference: one query without the customer predicate
    const seeded = [...records, { text: 'SELECT * FROM idt.membership WHERE body_id = $1', params: [BODY] }]
    expect(scopeProblems(seeded, [A_ID], []).join('\n')).toMatch(/unscoped query .*idt\.membership/)
    await app.close()
  })

  it('every bodies operation of the spec was exercised (not vacuous)', () => {
    const mine = listOperations(doc).filter((o) => (o.operation as { tags?: string[] }).tags?.includes('bodies')).map((o) => o.operationId!).sort()
    expect(mine).toEqual(['createBody', 'getBodyTree', 'getOwnPreference', 'getPerson', 'invitePerson', 'listBodyMemberships', 'listBodySeats', 'listSeatTenures', 'putOwnPreference', 'startMembership'])
    expect([...exercised].sort()).toEqual(mine)
  })
})
