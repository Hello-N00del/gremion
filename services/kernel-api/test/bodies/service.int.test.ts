// TASK-080-a step b (live half): the identity domain service on a scratch PG18,
// over the REAL migrated chain and the app-role pool the service runs on.
// Post-conditions are rows and outbox rows, never an exit code.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Ajv } from 'ajv'
import addFormats from 'ajv-formats'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { denyAll, operatorAuthorizer, type Actor } from '../../src/bodies/authz.ts'
import { BodiesError } from '../../src/bodies/errors.ts'
import { createBodiesService, type OpCtx } from '../../src/bodies/service.ts'
import { preferenceOps } from '../../src/bodies/preference.ts'
import { asCustomer, buildBodiesWorld, type BodiesWorld } from '../harness/bodies-world.ts'
import { uuidv7, type Customer } from '../harness/scratch.ts'

const SPEC = JSON.parse(readFileSync(fileURLToPath(new URL('../../asyncapi/idt.json', import.meta.url)), 'utf8')) as { components: { schemas: Record<string, object> } }

let w: BodiesWorld
let A: Customer
let B: Customer
const operator: Actor = { kind: 'operator', id: uuidv7() }
const svc = createBodiesService({ authorizer: operatorAuthorizer })
const denied = createBodiesService({ authorizer: denyAll })
let ctxA: OpCtx
let ctxB: OpCtx

const refuses = async (p: Promise<unknown>, code: string, constraint?: string) => {
  const e = await p.then(() => null, (x: unknown) => x)
  expect(e, `expected ${code}`).toBeInstanceOf(BodiesError)
  expect((e as BodiesError).code).toBe(code)
  if (constraint) expect((e as BodiesError).constraint).toBe(constraint)
}

const counts = async (c: Customer) => {
  const a = w.adminPool(c)
  const [r] = await a<{ bodies: number; units: number; seats: number; persons: number; memberships: number; tenures: number; outbox: number }[]>`
    SELECT (SELECT count(*)::int FROM idt.body) AS bodies, (SELECT count(*)::int FROM idt.org_unit) AS units, (SELECT count(*)::int FROM idt.seat) AS seats,
           (SELECT count(*)::int FROM idt.person) AS persons, (SELECT count(*)::int FROM idt.membership) AS memberships, (SELECT count(*)::int FROM idt.tenure) AS tenures,
           (SELECT count(*)::int FROM idt.outbox) AS outbox`
  return r!
}

beforeAll(async () => {
  w = await buildBodiesWorld('service')
  A = await w.customer('svc-a', 'svc-a.example.org')
  B = await w.customer('svc-b', 'svc-b.example.org')
  ctxA = { sql: w.appPool(A), customerId: A.id, actor: operator }
  ctxB = { sql: w.appPool(B), customerId: B.id, actor: operator }
}, 300_000)
afterAll(async () => {
  await w?.close()
})

describe('the identity domain service (one tx per operation, events in the same tx)', () => {
  const ids: Record<string, string> = {}

  it('writes the whole structure and every aggregate event lands in idt.outbox, valid against asyncapi/idt.json', async () => {
    const body = await svc.createBody(ctxA, { kindKey: 'stura', name: 'Studierendenrat', shortName: 'StuRa' })
    ids.body = body.bodyId
    const council = await svc.createOrgUnit(ctxA, { bodyId: body.bodyId, kindKey: 'council', name: 'Plenum' })
    const committee = await svc.createOrgUnit(ctxA, { bodyId: body.bodyId, kindKey: 'committee', name: 'Vorstand', parentOrgUnitId: council.orgUnitId })
    ids.unit = committee.orgUnitId
    const seat = await svc.createSeat(ctxA, { bodyId: body.bodyId, orgUnitId: committee.orgUnitId, title: 'Vorsitz', seatKind: 'office', fillMode: 'direct_election', voting: true })
    ids.seat = seat.seatId
    const wp = await svc.createWahlperiode(ctxA, { bodyId: body.bodyId, label: '2026/27', startsOn: '2026-04-01', endsOn: '2027-03-31' })
    ids.wp = wp.wahlperiodeId
    const p = await svc.invitePerson(ctxA, { email: 'Ada@Example.org', displayName: 'Ada Beispiel' })
    ids.person = p.personId
    await svc.activatePerson(ctxA, p.personId, { idpSubject: 'kc-sub-ada' })
    const m = await svc.startMembership(ctxA, { personId: p.personId, bodyId: body.bodyId, orgUnitId: committee.orgUnitId, participationKind: 'elected_member', voting: true, validFrom: '2026-04-01', wahlperiodeId: wp.wahlperiodeId, source: 'admin' })
    ids.membership = m.membershipId
    const t = await svc.startTenure(ctxA, { seatId: seat.seatId, personId: p.personId, startsOn: '2026-04-01', wahlperiodeId: wp.wahlperiodeId, source: 'election' })
    ids.tenure = t.tenureId

    const admin = w.adminPool(A)
    const rows = await admin<{ event_type: string; aggregate_type: string; aggregate_id: string; aggregate_version: number; data: Record<string, unknown>; source: string; tenantid: string; customer_id: string; relay_state: string }[]>`
      SELECT event_type, aggregate_type, aggregate_id::text, aggregate_version::int, data, source, tenantid, customer_id::text, relay_state FROM idt.outbox ORDER BY event_time, event_id`
    expect(rows.map((r) => r.event_type)).toEqual([
      'de.gremion.idt.body.created.v1', 'de.gremion.idt.orgunit.created.v1', 'de.gremion.idt.orgunit.created.v1', 'de.gremion.idt.seat.created.v1',
      'de.gremion.idt.wahlperiode.created.v1', 'de.gremion.idt.person.invited.v1', 'de.gremion.idt.person.activated.v1', 'de.gremion.idt.membership.started.v1', 'de.gremion.idt.tenure.started.v1',
    ])
    const ajv = new Ajv({ strict: false })
    addFormats.default(ajv)
    for (const r of rows) {
      expect(r.source).toBe('/gremion/idt')
      expect(r.customer_id).toBe(A.id)
      expect(r.tenantid).toBe(A.id)
      expect(r.relay_state).toBe('pending')
      const [, , , agg, ev] = r.event_type.split('.')
      const name = `${agg!.charAt(0).toUpperCase()}${agg!.slice(1)}${ev!.charAt(0).toUpperCase()}${ev!.slice(1)}Payload`
      const validate = ajv.compile(SPEC.components.schemas[name]!)
      expect(validate(r.data), `${r.event_type}: ${JSON.stringify(validate.errors)} ${JSON.stringify(r.data)}`).toBe(true)
    }
    // the aggregate id and version of the row are the state row's
    const person = rows.find((r) => r.event_type.endsWith('person.activated.v1'))!
    expect(person.aggregate_id).toBe(ids.person)
    expect(person.aggregate_version).toBe(2)
    // no payload carries a name or an e-mail address (TRD-154)
    expect(JSON.stringify(rows.map((r) => r.data))).not.toMatch(/Ada|example\.org/i)
    // created_by is the operator, not a person
    expect(await admin`SELECT created_by_kind, created_by::text FROM idt.body`).toEqual([{ created_by_kind: 'operator', created_by: operator.id }])
  })

  it('the single-holder seat refuses a second holder (gist EXCLUDE); a succession ends the first tenure and both events commit together', async () => {
    const q = await svc.invitePerson(ctxA, { email: 'bo@example.org', displayName: 'Bo Zwei' })
    await refuses(svc.startTenure(ctxA, { seatId: ids.seat!, personId: q.personId, startsOn: '2026-06-01', source: 'election' }), 'CONFLICT', 'tenure_seat_id_starts_on_ended_on_excl')
    const before = await counts(A)
    const s = await svc.startTenure(ctxA, { seatId: ids.seat!, personId: q.personId, startsOn: '2026-09-01', source: 'election', succession: true })
    const admin = w.adminPool(A)
    expect(await admin`SELECT tenure_id::text, ended_on::text, end_reason, source FROM idt.tenure ORDER BY starts_on`).toEqual([
      { tenure_id: ids.tenure, ended_on: '2026-08-31', end_reason: 'succeeded', source: 'election' },
      { tenure_id: s.tenureId, ended_on: null, end_reason: null, source: 'succession' },
    ])
    expect((await counts(A)).outbox - before.outbox).toBe(2)
    const ev = await admin<{ event_type: string }[]>`SELECT event_type FROM idt.outbox ORDER BY event_time DESC, event_id DESC LIMIT 2`
    expect(ev.map((e) => e.event_type).sort()).toEqual(['de.gremion.idt.tenure.ended.v1', 'de.gremion.idt.tenure.started.v1'])
    ids.tenure2 = s.tenureId
  })

  it('Q8: a kind the catalogue does not hold, or of the other level, refuses (no row, no event)', async () => {
    const before = await counts(A)
    await refuses(svc.createBody(ctxA, { kindKey: 'nonexistent', name: 'X' }), 'UNMAPPED_KIND')
    await refuses(svc.createBody(ctxA, { kindKey: 'council', name: 'Unit kind as body' }), 'UNMAPPED_KIND')
    await refuses(svc.createOrgUnit(ctxA, { bodyId: ids.body!, kindKey: 'stura', name: 'Body kind as unit' }), 'UNMAPPED_KIND')
    await w.adminPool(A)`UPDATE idt.org_unit_kind SET state = 'retired' WHERE kind_key = 'group'`
    await refuses(svc.createOrgUnit(ctxA, { bodyId: ids.body!, kindKey: 'group', name: 'Retired kind' }), 'UNMAPPED_KIND')
    await w.adminPool(A)`UPDATE idt.org_unit_kind SET state = 'active' WHERE kind_key = 'group'`
    expect(await counts(A)).toEqual(before)
  })

  it('Q4: default deny. The shipped authorizer refuses every write, a person actor is refused by the operator authorizer; nothing is written', async () => {
    const before = await counts(A)
    await refuses(denied.createBody(ctxA, { kindKey: 'stupa', name: 'Parlament' }), 'FORBIDDEN')
    await refuses(denied.endMembership(ctxA, ids.membership!, { validUntil: '2026-12-31', endReason: 'term_end' }), 'FORBIDDEN')
    await refuses(denied.invitePerson(ctxA, { email: 'x@example.org', displayName: 'X' }), 'FORBIDDEN')
    const asPerson: OpCtx = { ...ctxA, actor: { kind: 'person', id: ids.person! } }
    await refuses(svc.createBody(asPerson, { kindKey: 'stupa', name: 'Parlament' }), 'FORBIDDEN')
    expect(await counts(A)).toEqual(before)
  })

  it('atomicity: a commit that fails AFTER the event was enqueued leaves neither the row nor the outbox row (guard 4: enqueue after commit would orphan it)', async () => {
    const admin = w.adminPool(A)
    await admin`CREATE OR REPLACE FUNCTION idt.t080_fail_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced failure at commit' USING ERRCODE = 'check_violation'; END $$`
    await admin`CREATE CONSTRAINT TRIGGER t080_fail_commit AFTER INSERT ON idt.body DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION idt.t080_fail_at_commit()`
    const before = await counts(A)
    try {
      await refuses(svc.createBody(ctxA, { kindKey: 'stupa', name: 'Nie committed' }), 'INVALID')
    } finally {
      await admin`DROP TRIGGER t080_fail_commit ON idt.body`
      await admin`DROP FUNCTION idt.t080_fail_at_commit()`
    }
    expect(await counts(A)).toEqual(before)
    expect(await admin`SELECT count(*)::int AS n FROM idt.body WHERE name = 'Nie committed'`).toEqual([{ n: 0 }])
    expect(await admin`SELECT count(*)::int AS n FROM idt.outbox WHERE data->>'kind_key' = 'stupa'`).toEqual([{ n: 0 }])
  })

  it('atomicity, the other direction: an enqueue that FAILS leaves no row behind (state committed without its event would be silent data the relay never publishes)', async () => {
    const admin = w.adminPool(A)
    await admin`CREATE OR REPLACE FUNCTION idt.t080_fail_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced enqueue failure' USING ERRCODE = 'check_violation'; END $$`
    await admin`CREATE TRIGGER t080_fail_outbox BEFORE INSERT ON idt.outbox FOR EACH ROW EXECUTE FUNCTION idt.t080_fail_enqueue()`
    const before = await counts(A)
    try {
      await refuses(svc.createBody(ctxA, { kindKey: 'stupa', name: 'Ohne Ereignis' }), 'INVALID')
      await refuses(svc.invitePerson(ctxA, { email: 'ohne-ereignis@example.org', displayName: 'Ohne Ereignis' }), 'INVALID')
    } finally {
      await admin`DROP TRIGGER t080_fail_outbox ON idt.outbox`
      await admin`DROP FUNCTION idt.t080_fail_enqueue()`
    }
    expect(await counts(A)).toEqual(before)
    expect(await admin`SELECT (SELECT count(*)::int FROM idt.body WHERE name = 'Ohne Ereignis') AS bodies, (SELECT count(*)::int FROM idt.person WHERE email = 'ohne-ereignis@example.org') AS persons`).toEqual([{ bodies: 0, persons: 0 }])
  })

  it('guard 5: a non_voting_helper with voting=true is refused by the DATABASE (23514 membership_voting_check); a voting=false helper is accepted and distinct from elected_member', async () => {
    const h = await svc.invitePerson(ctxA, { email: 'helfer@example.org', displayName: 'Helfer Eins' })
    const e = await svc.startMembership(ctxA, { personId: h.personId, bodyId: ids.body!, participationKind: 'non_voting_helper', voting: true, validFrom: '2026-04-01', source: 'admin' }).then(() => null, (x: unknown) => x as BodiesError)
    expect(e).toBeInstanceOf(BodiesError)
    expect(e!.code).toBe('INVALID')
    expect(e!.constraint).toBe('membership_voting_check')
    expect((e!.cause as { code?: string }).code).toBe('23514')
    const ok = await svc.startMembership(ctxA, { personId: h.personId, bodyId: ids.body!, participationKind: 'non_voting_helper', voting: false, validFrom: '2026-04-01', source: 'admin' })
    expect(await w.adminPool(A)`SELECT participation_kind, voting, retention_profile_id FROM idt.membership WHERE membership_id = ${ok.membershipId}::uuid`).toEqual([
      { participation_kind: 'non_voting_helper', voting: false, retention_profile_id: 'rp-idt-membership' },
    ])
  })

  it('membership: overlapping validity of the same person, body, unit and kind is refused (EXCLUDE); correct and end emit corrected / ended with the changed fields', async () => {
    await refuses(
      svc.startMembership(ctxA, { personId: ids.person!, bodyId: ids.body!, orgUnitId: ids.unit!, participationKind: 'elected_member', voting: true, validFrom: '2026-06-01', source: 'admin' }),
      'CONFLICT',
      'membership_person_id_body_id_unit_kind_validity_excl',
    )
    await refuses(svc.correctMembership(ctxA, ids.membership!, { voting: true }), 'INVALID') // changes nothing
    await refuses(svc.correctMembership(ctxA, ids.membership!, { voting: false, expectedVersion: 99 }), 'CONFLICT', 'row_version')
    const c = await svc.correctMembership(ctxA, ids.membership!, { voting: false, expectedVersion: 1 })
    expect(c.rowVersion).toBe(2)
    await svc.endMembership(ctxA, ids.membership!, { validUntil: '2027-03-31', endReason: 'term_end' })
    await refuses(svc.endMembership(ctxA, ids.membership!, { validUntil: '2027-03-31', endReason: 'term_end' }), 'INVALID')
    const ev = await w.adminPool(A)<{ event_type: string; data: { changed?: string[]; voting?: boolean; valid_until?: string }; aggregate_version: number }[]>`
      SELECT event_type, data, aggregate_version::int FROM idt.outbox WHERE aggregate_id = ${ids.membership!}::uuid ORDER BY aggregate_version`
    expect(ev.map((e) => [e.event_type, e.aggregate_version])).toEqual([
      ['de.gremion.idt.membership.started.v1', 1], ['de.gremion.idt.membership.corrected.v1', 2], ['de.gremion.idt.membership.ended.v1', 3],
    ])
    expect(ev[1]!.data.changed).toEqual(['voting'])
  })

  it('persons: the state machine (invite, activate, disable, enable), a duplicate e-mail (any case) is refused, a wrong transition is INVALID', async () => {
    await refuses(svc.invitePerson(ctxA, { email: 'ada@EXAMPLE.org', displayName: 'Ada Doppelt' }), 'CONFLICT', 'person_email_lower_key')
    await refuses(svc.enablePerson(ctxA, ids.person!), 'INVALID')
    await svc.disablePerson(ctxA, ids.person!)
    expect(await w.adminPool(A)`SELECT account_state, disabled_at IS NOT NULL AS has_disabled FROM idt.person WHERE person_id = ${ids.person!}::uuid`).toEqual([{ account_state: 'disabled', has_disabled: true }])
    await svc.enablePerson(ctxA, ids.person!)
    expect(await w.adminPool(A)`SELECT account_state, disabled_at FROM idt.person WHERE person_id = ${ids.person!}::uuid`).toEqual([{ account_state: 'active', disabled_at: null }])
    const versions = await w.adminPool(A)<{ event_type: string; aggregate_version: number }[]>`SELECT event_type, aggregate_version::int FROM idt.outbox WHERE aggregate_id = ${ids.person!}::uuid ORDER BY aggregate_version`
    expect(versions.map((v) => v.aggregate_version)).toEqual([1, 2, 3, 4])
  })

  it('structure rules: cycle, archive with active content, seat on a unit whose kind holds no seats, retire a seat with an open tenure', async () => {
    const g = await svc.createOrgUnit(ctxA, { bodyId: ids.body!, kindKey: 'group', name: 'AG Test', parentOrgUnitId: ids.unit! })
    await refuses(svc.updateOrgUnit(ctxA, ids.unit!, { parentOrgUnitId: g.orgUnitId }), 'INVALID') // org_unit_acyclic (23514)
    await refuses(svc.createSeat(ctxA, { bodyId: ids.body!, orgUnitId: g.orgUnitId, title: 'Sitz', seatKind: 'advisory', fillMode: 'appointment', voting: false }), 'INVALID')
    await refuses(svc.retireSeat(ctxA, ids.seat!), 'CONFLICT')
    await refuses(svc.archiveBody(ctxA, ids.body!), 'CONFLICT')
    await refuses(svc.archiveOrgUnit(ctxA, ids.unit!), 'CONFLICT')
    await svc.archiveOrgUnit(ctxA, g.orgUnitId)
    const rows = await w.adminPool(A)`SELECT state, archived_at IS NOT NULL AS archived FROM idt.org_unit WHERE org_unit_id = ${g.orgUnitId}::uuid`
    expect(rows).toEqual([{ state: 'archived', archived: true }])
  })

  it('rows are never deleted: refuse_delete on body, org unit, seat, wahlperiode', async () => {
    const admin = w.adminPool(A)
    for (const t of ['body', 'org_unit', 'seat', 'wahlperiode']) {
      const e = await admin.unsafe(`DELETE FROM idt.${t}`).then(() => null, (x: unknown) => x as { code?: string; message?: string })
      expect(e?.code, t).toBe('23514')
      expect(e?.message).toMatch(/never deleted/)
    }
  })

  it('tenant isolation: customer B holds none of A\'s rows; A\'s rows are invisible without the GUC and under another customer\'s GUC; a write under the wrong GUC is refused', async () => {
    expect(await counts(B)).toEqual({ bodies: 0, units: 0, seats: 0, persons: 0, memberships: 0, tenures: 0, outbox: 0 })
    const sql = ctxA.sql
    expect(await sql`SELECT count(*)::int AS n FROM idt.body`).toEqual([{ n: 0 }]) // no GUC on a pooled connection: nothing (the GUC is transaction-local)
    expect(await asCustomer(sql, B.id, (tx) => tx`SELECT count(*)::int AS n FROM idt.body`)).toEqual([{ n: 0 }])
    expect(await asCustomer(sql, A.id, (tx) => tx`SELECT count(*)::int AS n FROM idt.body`)).toEqual([{ n: 1 }])
    const e = await asCustomer(sql, B.id, (tx) => tx`INSERT INTO idt.body (customer_id, kind_key, name, created_by_kind, updated_by_kind) VALUES (${A.id}::uuid, 'stura', 'Fremd', 'system', 'system')`).then(() => null, (x: unknown) => x as { code?: string })
    expect(e?.code).toBe('42501')
    // and the service itself, handed B's pool with A's id, writes nothing for A (the GUC is A's, the database is B's: the binding of B stays B's)
    const svcOnB: OpCtx = { ...ctxB, customerId: B.id }
    await svc.createBody(svcOnB, { kindKey: 'stura', name: 'Studierendenrat B' })
    expect((await counts(B)).bodies).toBe(1)
    expect((await counts(A)).bodies).toBe(1)
  })

  it('a fixed-term membership (valid_until in the future, no end_reason) is OPEN: it can be ended early (earlier date + end_reason), never extended, and it blocks archiving until it has ended (house review 2)', async () => {
    const body = await svc.createBody(ctxA, { kindKey: 'stura', name: 'Fachschaftsrat Befristet' })
    const unit = await svc.createOrgUnit(ctxA, { bodyId: body.bodyId, kindKey: 'committee', name: 'Ausschuss Befristet' })
    const p = await svc.invitePerson(ctxA, { email: 'befristet@example.org', displayName: 'Bea Befristet' })
    await svc.activatePerson(ctxA, p.personId, { idpSubject: 'kc-sub-bea' })
    const onBody = await svc.startMembership(ctxA, { personId: p.personId, bodyId: body.bodyId, participationKind: 'initiative_member', voting: false, validFrom: '2026-01-01', validUntil: '2099-12-31', source: 'admin' })
    const onUnit = await svc.startMembership(ctxA, { personId: p.personId, bodyId: body.bodyId, orgUnitId: unit.orgUnitId, participationKind: 'initiative_member', voting: false, validFrom: '2026-01-01', validUntil: '2099-12-31', source: 'admin' })
    // an unended fixed-term membership is open: neither the body nor the unit archives under it
    await refuses(svc.archiveOrgUnit(ctxA, unit.orgUnitId), 'CONFLICT')
    expect(await w.adminPool(A)`SELECT state FROM idt.org_unit WHERE org_unit_id = ${unit.orgUnitId}::uuid`).toEqual([{ state: 'active' }])
    await refuses(svc.archiveBody(ctxA, body.bodyId), 'CONFLICT')
    expect(await w.adminPool(A)`SELECT state FROM idt.body WHERE body_id = ${body.bodyId}::uuid`).toEqual([{ state: 'active' }])
    // ending early may not push the end further out
    await refuses(svc.endMembership(ctxA, onBody.membershipId, { validUntil: '2100-01-01', endReason: 'resigned' }), 'INVALID')
    const e = await svc.endMembership(ctxA, onBody.membershipId, { validUntil: '2026-06-30', endReason: 'resigned' })
    expect(e.rowVersion).toBe(2)
    expect(await w.adminPool(A)`SELECT valid_until::text AS valid_until, end_reason FROM idt.membership WHERE membership_id = ${onBody.membershipId}::uuid`).toEqual([{ valid_until: '2026-06-30', end_reason: 'resigned' }])
    // a membership that carries an end_reason is ended, whatever its date
    await refuses(svc.endMembership(ctxA, onBody.membershipId, { validUntil: '2026-05-31', endReason: 'removed' }), 'INVALID')
    const ev = await w.adminPool(A)<{ event_type: string; data: { valid_until?: string; end_reason?: string } }[]>`
      SELECT event_type, data FROM idt.outbox WHERE aggregate_id = ${onBody.membershipId}::uuid ORDER BY aggregate_version`
    expect(ev.map((x) => x.event_type)).toEqual(['de.gremion.idt.membership.started.v1', 'de.gremion.idt.membership.ended.v1'])
    expect(ev[1]!.data).toMatchObject({ valid_until: '2026-06-30', end_reason: 'resigned' })
    // once the last one has ended in the past, the unit and then the body archive
    await svc.endMembership(ctxA, onUnit.membershipId, { validUntil: '2026-06-30', endReason: 'term_end' })
    await svc.archiveOrgUnit(ctxA, unit.orgUnitId)
    await svc.archiveBody(ctxA, body.bodyId)
    expect(await w.adminPool(A)`SELECT state FROM idt.body WHERE body_id = ${body.bodyId}::uuid`).toEqual([{ state: 'archived' }])
  })

  it('preference: found by the verified subject only; follow_customer resolves through customer_setting; an unknown subject is NOT_FOUND', async () => {
    const pctx = { sql: ctxA.sql, customerId: A.id }
    const first = await preferenceOps.getPreferenceBySubject(pctx, 'kc-sub-ada')
    expect(first).toMatchObject({ personId: ids.person, locale: 'follow_customer', effectiveLocale: 'de', stored: false, rowVersion: 0 })
    expect(await preferenceOps.getPreferenceBySubject(pctx, 'someone-else')).toBeNull()
    const saved = await preferenceOps.upsertPreferenceBySubject(pctx, 'kc-sub-ada', { locale: 'en' })
    expect(saved).toMatchObject({ locale: 'en', effectiveLocale: 'en', stored: true, rowVersion: 1, updatedByKind: 'person', updatedBy: ids.person })
    const again = await preferenceOps.upsertPreferenceBySubject(pctx, 'kc-sub-ada', { colourScheme: 'dark' })
    expect(again).toMatchObject({ locale: 'en', colourScheme: 'dark', rowVersion: 2 })
    await preferenceOps.upsertPreferenceBySubject(pctx, 'kc-sub-ada', { locale: 'follow_customer' })
    await w.adminPool(A)`UPDATE idt.customer_setting SET default_locale = 'en'`
    expect(await preferenceOps.getPreferenceBySubject(pctx, 'kc-sub-ada')).toMatchObject({ locale: 'follow_customer', effectiveLocale: 'en' })
    await refuses(preferenceOps.upsertPreferenceBySubject(pctx, 'someone-else', { locale: 'de' }), 'NOT_FOUND')
    // a disabled person's subject resolves to nothing
    await svc.disablePerson(ctxA, ids.person!)
    expect(await preferenceOps.getPreferenceBySubject(pctx, 'kc-sub-ada')).toBeNull()
    await svc.enablePerson(ctxA, ids.person!)
    await refuses(preferenceOps.upsertPreferenceBySubject(pctx, 'kc-sub-ada', { locale: 'xx' as 'de' }), 'INVALID')
  })
})
