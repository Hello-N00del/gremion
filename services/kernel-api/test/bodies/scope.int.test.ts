// TASK-080-a round 3 (MEDIUM), TRD-082 for the WRITE side: every query the identity domain service issues
// (people.ts, structure.ts, core.ts) carries the customer predicate, whatever the operation. Run over the real
// migrated chain on the scratch PG18 under operatorAuthorizer; the recorder wraps the app-role pool, so what is
// checked is the text and parameters of the queries that actually ran, not a scan of the source.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { operatorAuthorizer, type Actor } from '../../src/bodies/authz.ts'
import { createBodiesService, type OpCtx } from '../../src/bodies/service.ts'
import { buildBodiesWorld, type BodiesWorld } from '../harness/bodies-world.ts'
import { recordingPool, scopeProblems, type RecordedQuery } from '../harness/query-recorder.ts'
import { uuidv7, type Customer } from '../harness/scratch.ts'

let w: BodiesWorld
let C: Customer
const operator: Actor = { kind: 'operator', id: uuidv7() }
const svc = createBodiesService({ authorizer: operatorAuthorizer })
const records: RecordedQuery[] = []
let ctx: OpCtx

beforeAll(async () => {
  w = await buildBodiesWorld('scope')
  C = await w.customer('scope-c', 'scope-c.example.org')
  ctx = { sql: recordingPool(records, w.appPool(C)), customerId: C.id, actor: operator }
}, 300_000)
afterAll(async () => {
  await w?.close()
})

describe('TRD-082 on the write side: every domain-service query carries the customer id', () => {
  it('all 20 write operations ran; no recorded query lacks the customer predicate', async () => {
    const body = await svc.createBody(ctx, { kindKey: 'stura', name: 'Rat' })
    const child = await svc.createBody(ctx, { kindKey: 'fachschaftsrat', name: 'FSR', parentBodyId: body.bodyId })
    await svc.updateBody(ctx, body.bodyId, { name: 'Rat 2' })
    await svc.archiveBody(ctx, child.bodyId)
    const council = await svc.createOrgUnit(ctx, { bodyId: body.bodyId, kindKey: 'council', name: 'Plenum' })
    const unit = await svc.createOrgUnit(ctx, { bodyId: body.bodyId, kindKey: 'committee', name: 'Vorstand', parentOrgUnitId: council.orgUnitId })
    await svc.updateOrgUnit(ctx, unit.orgUnitId, { name: 'Vorstand 2' })
    const group = await svc.createOrgUnit(ctx, { bodyId: body.bodyId, kindKey: 'group', name: 'AG' })
    await svc.archiveOrgUnit(ctx, group.orgUnitId)
    const seat = await svc.createSeat(ctx, { bodyId: body.bodyId, orgUnitId: unit.orgUnitId, title: 'Vorsitz', seatKind: 'office', fillMode: 'direct_election', voting: true })
    const seat2 = await svc.createSeat(ctx, { bodyId: body.bodyId, orgUnitId: unit.orgUnitId, title: 'Beisitz', seatKind: 'office', fillMode: 'direct_election', voting: true })
    await svc.retireSeat(ctx, seat2.seatId)
    const wp = await svc.createWahlperiode(ctx, { bodyId: body.bodyId, label: '2026/27', startsOn: '2026-04-01', endsOn: '2027-03-31' })
    const wp2 = await svc.createWahlperiode(ctx, { bodyId: body.bodyId, label: '2025/26', startsOn: '2025-04-01', endsOn: '2026-03-31' })
    await svc.closeWahlperiode(ctx, wp2.wahlperiodeId)
    const p = await svc.invitePerson(ctx, { email: 'scope-p@example.org', displayName: 'Pia' })
    await svc.activatePerson(ctx, p.personId, { idpSubject: 'kc-scope-p' })
    await svc.disablePerson(ctx, p.personId)
    await svc.enablePerson(ctx, p.personId)
    const q = await svc.invitePerson(ctx, { email: 'scope-q@example.org', displayName: 'Quentin' })
    const m = await svc.startMembership(ctx, { personId: p.personId, bodyId: body.bodyId, orgUnitId: unit.orgUnitId, participationKind: 'elected_member', voting: true, validFrom: '2026-04-01', wahlperiodeId: wp.wahlperiodeId, source: 'admin' })
    await svc.correctMembership(ctx, m.membershipId, { voting: false })
    await svc.endMembership(ctx, m.membershipId, { validUntil: '2027-03-31', endReason: 'term_end' })
    const t = await svc.startTenure(ctx, { seatId: seat.seatId, personId: p.personId, startsOn: '2026-04-01', wahlperiodeId: wp.wahlperiodeId, source: 'election' })
    await svc.correctTenure(ctx, t.tenureId, { plannedEndOn: '2027-03-31' })
    const t2 = await svc.startTenure(ctx, { seatId: seat.seatId, personId: q.personId, startsOn: '2026-09-01', source: 'election', succession: true })
    await svc.endTenure(ctx, t2.tenureId, { endedOn: '2026-12-31', endReason: 'resigned' })

    expect(scopeProblems(records, [C.id], [])).toEqual([])
    // not vacuous: the tables the audit named were all touched by recorded queries, reads and writes
    const text = records.map((r) => r.text).join('\n')
    for (const t of ['idt.person', 'idt.body', 'idt.org_unit', 'idt.seat', 'idt.wahlperiode', 'idt.membership', 'idt.tenure', 'idt.org_unit_kind']) expect(text, t).toContain(t)
    expect(records.filter((r) => /^(INSERT|UPDATE)/.test(r.text)).length).toBeGreaterThanOrEqual(25)
    // and every one of the SERVICE's own statements (not the tx's set_config) names the predicate in its text
    const unpredicated = records.filter((r) => !r.text.startsWith('SELECT set_config') && !/\bcustomer_id\b/.test(r.text))
    expect(unpredicated.map((r) => r.text)).toEqual([])
  })

  it('a seeded unscoped query is RED (the recorder is not a rubber stamp)', () => {
    const seeded = [...records, { text: 'SELECT state FROM idt.body WHERE body_id = $1', params: [uuidv7()] }]
    expect(scopeProblems(seeded, [C.id], []).join('\n')).toMatch(/unscoped query .*idt\.body/)
  })
})
