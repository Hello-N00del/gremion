// TDD 7, 8, 11, 12, 16 + M-OFF-2/4: the grant service (TRD-091, TRD-090, R29-I7),
// events in the same transaction, the sweep.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GrantError } from '../../src/authz/errors.ts'
import { issueGrant, listGrants, revokeAllForPerson, revokeGrant, type GrantDeps, type Granter } from '../../src/authz/grants.ts'
import { decide } from '../../src/authz/pdp.ts'
import { sweepGrants } from '../../src/authz/sweep.ts'
import { uuidv7 } from './db.ts'
import { buildWorld, insertPerson, makeRegistry, seedGrant, type World } from './world.ts'

let w: World
let w2: World
let w3: World
const reg = makeRegistry(['publishing', 'votes', 'board', 'calendar', 'finance'])
const NOW = () => Math.floor(Date.now() / 1000)
const deps: GrantDeps = { enabledModules: reg.read }

const claims = (sub: string, o: Record<string, unknown> = {}): Granter => ({ kind: 'person', claims: { sub, acr: 'loa2', auth_time: NOW() - 10, ...o } })
const refused = async (p: Promise<unknown>): Promise<GrantError> => {
  try {
    await p
  } catch (e) {
    if (e instanceof GrantError) return e
    throw e
  }
  throw new Error('expected a GrantError, the call succeeded')
}
const count = async (world: World) => Number((await world.db.admin`SELECT count(*)::int AS n FROM idt.authz_grant`)[0]!.n)
const events = async (world: World, grantId: string) =>
  world.db.admin<{ event_type: string; aggregate_version: string }[]>`SELECT event_type, aggregate_version::text FROM idt.outbox WHERE aggregate_id = ${grantId}::uuid ORDER BY aggregate_version`

beforeAll(async () => {
  w = await buildWorld('grants', undefined, ['admin', 'alice', 'bob', 'carol', 'impostor', 'dave', 'itv', 'itfach', 'fin', 'carev', 'caexp'])
  w2 = await buildWorld('grants2', undefined, ['admin'])
  w3 = await buildWorld('grants3', undefined, ['ca3', 'target3'])
  await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.admin!, key: 'body_admin' })
  await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.impostor!, key: 'member' })
  await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.verwaltung, personId: w.persons.admin!, key: 'body_admin' })
  await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.verwaltung, personId: w.persons.carol!, key: 'council_admin' })
  await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.dave!, key: 'body_admin' })
  await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.verwaltung, personId: w.persons.itv!, key: 'it_admin' })
  await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.itfach!, key: 'it_admin' }) // customer role in a non-verwaltung body: seeded as the owner
  await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.verwaltung, personId: w.persons.fin!, key: 'finance' }) // customer-level role WITHOUT idt.grant.manage
  const revokedId = await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.verwaltung, personId: w.persons.carev!, key: 'council_admin' })
  await w.db.admin`UPDATE idt.authz_grant SET state = 'revoked', revoked_at = now(), revoke_reason = 'manual', revoked_by_kind = 'system' WHERE grant_id = ${revokedId}::uuid`
  await seedGrant(w3.db.admin, w3.db.customerId, { bodyId: w3.verwaltung, personId: w3.persons.ca3!, key: 'council_admin' })
})
afterAll(async () => {
  await Promise.allSettled([w?.db.close(), w2?.db.close(), w3?.db.close()])
})

const base = (o: Record<string, unknown> = {}) => ({ bodyId: w.bodyA, subjectPersonId: w.persons.alice!, grantKind: 'role' as const, key: 'member', granterRole: 'body_admin', ...o })

describe('TRD-091 server-verified granter role', () => {
  it('a mismatching client-supplied granterRole is 403 with 0 rows; the matching one is 201', async () => {
    const before = await count(w)
    const e = await refused(issueGrant(w.db.app, deps, w.db.customerId, claims('sub-admin'), base({ granterRole: 'council_admin' })))
    expect([e.code, e.status]).toEqual(['granter_role_mismatch', 403])
    expect(await count(w)).toBe(before)
    const g = await issueGrant(w.db.app, deps, w.db.customerId, claims('sub-admin'), base())
    expect(g.state).toBe('active')
    expect(g.granter_kind).toBe('person')
    expect(g.source).toBe('customer_admin')
    expect(await count(w)).toBe(before + 1)
  })
  it('a granter without the granting capability is refused; a self-grant is refused', async () => {
    expect((await refused(issueGrant(w.db.app, deps, w.db.customerId, claims('sub-impostor'), base({ granterRole: 'member' })))).code).toBe('forbidden')
    expect((await refused(issueGrant(w.db.app, deps, w.db.customerId, claims('sub-admin'), base({ subjectPersonId: w.persons.admin! })))).code).toBe('self_grant')
  })
})

describe('TRD-113/TRD-091 the granter role must include the granted role (catalogue, not the body)', () => {
  const code = async (p: Promise<unknown>) => {
    const e = await refused(p)
    return [e.code, e.status]
  }
  it('A1: a body_admin granting a role it does not include is 403 with 0 rows (finance, council_admin)', async () => {
    const before = await count(w)
    expect(await code(issueGrant(w.db.app, deps, w.db.customerId, claims('sub-admin'), base({ key: 'finance' })))).toEqual(['granter_role_mismatch', 403])
    expect(await code(issueGrant(w.db.app, deps, w.db.customerId, claims('sub-admin'), base({ bodyId: w.verwaltung, key: 'council_admin' })))).toEqual(['granter_role_mismatch', 403])
    expect(await count(w)).toBe(before)
  })
  it('probe: a body_admin granting a capability outside every role it can grant (fin.expense.approve) is 403 with 0 rows', async () => {
    const before = await count(w)
    expect(await code(issueGrant(w.db.app, deps, w.db.customerId, claims('sub-admin'), base({ grantKind: 'capability', key: 'fin.expense.approve' })))).toEqual(['granter_role_mismatch', 403])
    expect(await count(w)).toBe(before)
  })
  it('a body_admin may grant a capability that a body role carries (brd.card.own: 201)', async () => {
    const g = await issueGrant(w.db.app, deps, w.db.customerId, claims('sub-admin'), base({ grantKind: 'capability', key: 'brd.card.own', subjectPersonId: w.persons.bob! }))
    expect(g.capability_key).toBe('brd.card.own')
  })
  it('a council_admin (customer-level) grants finance in the verwaltung (201)', async () => {
    const g = await issueGrant(w.db.app, deps, w.db.customerId, claims('sub-carol'), base({ bodyId: w.verwaltung, key: 'finance', granterRole: 'council_admin', subjectPersonId: w.persons.bob! }))
    expect(g.role_key).toBe('finance')
  })
  it('DOMAIN: a body-level role is never granted in the verwaltung (422 role_scope, 0 rows)', async () => {
    const before = await count(w)
    expect(await code(issueGrant(w.db.app, deps, w.db.customerId, claims('sub-carol'), base({ bodyId: w.verwaltung, key: 'member', granterRole: 'council_admin', subjectPersonId: w.persons.alice! })))).toEqual(['role_scope', 422])
    expect(await count(w)).toBe(before)
  })
})

describe('malformed input is a 400, not a database cast error', () => {
  it('a malformed validUntil, resource id, or resource kind is bad_request with 0 rows', async () => {
    const before = await count(w)
    for (const o of [{ validUntil: 'not-a-date' }, { resource: { kind: 'meeting', id: 'nope' } }, { resource: { kind: '', id: uuidv7() } }]) {
      const e = await refused(issueGrant(w.db.app, deps, w.db.customerId, claims('sub-admin'), base({ subjectPersonId: w.persons.carol!, ...o })))
      expect([e.code, e.status]).toEqual(['bad_request', 400])
    }
    expect(await count(w)).toBe(before)
  })
})

describe('R29-I7 customer administrator inside their own tenant', () => {
  it('cannot grant into another tenant (0 rows) or a platform-level key', async () => {
    const before2 = await count(w2)
    const e = await refused(issueGrant(w.db.app, deps, w2.db.customerId, claims('sub-admin'), base({ bodyId: w2.bodyA, subjectPersonId: w2.persons.admin! })))
    expect(['forbidden', 'unknown_subject']).toContain(e.code)
    expect(await count(w2)).toBe(before2)
    const p = await refused(issueGrant(w.db.app, deps, w.db.customerId, claims('sub-admin'), base({ grantKind: 'capability', key: 'platform.operate' })))
    expect(p.code).toBe('platform_level')
  })
})

describe('TRD-090 step-up for privileged grants', () => {
  const req = (o: Record<string, unknown> = {}) => base({ key: 'body_admin', subjectPersonId: w.persons.bob!, ...o })
  it('refuses 401 insufficient_user_authentication with 0 rows: acr low, auth_time missing, auth_time stale', async () => {
    const before = await count(w)
    for (const c of [{ acr: 'loa1' }, { auth_time: undefined }, { auth_time: NOW() - 301 }]) {
      const e = await refused(issueGrant(w.db.app, deps, w.db.customerId, claims('sub-admin', c), req()))
      expect([e.code, e.status]).toEqual(['insufficient_user_authentication', 401])
    }
    expect(await count(w)).toBe(before)
  })
  it('allows with a fresh step-up (acr loa2, auth_time <= 300 s); an acr-only check would not', async () => {
    const g = await issueGrant(w.db.app, deps, w.db.customerId, claims('sub-admin', { auth_time: NOW() - 299 }), req())
    expect(g.role_key).toBe('body_admin')
  })
  it('a non-privileged grant needs no step-up', async () => {
    const g = await issueGrant(w.db.app, deps, w.db.customerId, claims('sub-admin', { acr: 'loa1', auth_time: undefined }), base({ subjectPersonId: w.persons.carol! }))
    expect(g.state).toBe('active')
  })
})

describe('module awareness on issue', () => {
  it('a capability of a disabled module is refused (409) with 0 rows', async () => {
    const off = makeRegistry(['votes'])
    const before = await count(w)
    const e = await refused(issueGrant(w.db.app, { enabledModules: off.read }, w.db.customerId, claims('sub-admin'), base({ grantKind: 'capability', key: 'newsletter.send' })))
    expect(e.code).toBe('module_not_enabled')
    expect(await count(w)).toBe(before)
  })
})

describe('events in the same transaction', () => {
  it('issue -> granted v1; revoke -> revoked v2; rollback leaves no outbox row', async () => {
    const g = await issueGrant(w.db.app, deps, w.db.customerId, claims('sub-admin'), base({ subjectPersonId: w.persons.bob!, key: 'helper' }))
    expect((await events(w, g.grant_id)).map((e) => [e.event_type, e.aggregate_version])).toEqual([['de.gremion.idt.grant.granted.v1', '1']])
    await revokeGrant(w.db.app, deps, w.db.customerId, claims('sub-admin'), g.grant_id)
    expect((await events(w, g.grant_id)).map((e) => [e.event_type, e.aggregate_version])).toEqual([
      ['de.gremion.idt.grant.granted.v1', '1'],
      ['de.gremion.idt.grant.revoked.v1', '2'],
    ])
    const outbox = Number((await w.db.admin`SELECT count(*)::int AS n FROM idt.outbox`)[0]!.n)
    const rows = Number((await w.db.admin`SELECT count(*)::int AS n FROM idt.authz_grant`)[0]!.n)
    // a failing second statement after the insert+enqueue rolls both back
    await expect(
      w.db.app.begin(async (tx) => {
        await tx`SELECT set_config('gremion.customer_id', ${w.db.customerId}, true)`
        const { emitGrantEvent } = await import('../../src/authz/events.ts')
        const id = uuidv7()
        await tx`INSERT INTO idt.authz_grant (grant_id, customer_id, body_id, subject_person_id, grant_kind, role_key, granter_kind, granted_by, source, state, created_by_kind, created_by, updated_by_kind, updated_by)
                 VALUES (${id}::uuid, ${w.db.customerId}::uuid, ${w.bodyA}::uuid, ${w.persons.carol!}::uuid, 'role', 'member', 'operator', ${uuidv7()}::uuid, 'control_panel', 'active', 'system', NULL, 'system', NULL)`
        await emitGrantEvent(tx as never, 'granted', { grant_id: id, body_id: w.bodyA, subject_person_id: w.persons.carol!, grant_kind: 'role', role_key: 'member', capability_key: null, resource_kind: null, resource_id: null, valid_from: new Date(), valid_until: null, granter_kind: 'operator', granted_by: null, source: 'control_panel', state: 'active', revoked_at: null, revoke_reason: null, row_version: 1 })
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(Number((await w.db.admin`SELECT count(*)::int AS n FROM idt.outbox`)[0]!.n)).toBe(outbox)
    expect(Number((await w.db.admin`SELECT count(*)::int AS n FROM idt.authz_grant`)[0]!.n)).toBe(rows)
  })
})

describe('sweep', () => {
  it('expiry emits expired.v1 once even with two concurrent sweepers; a due scheduled grant activates (granted again, higher version)', async () => {
    const past = new Date(Date.now() - 7_200_000).toISOString()
    const expiring = await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.alice!, key: 'idt.body.read', kind: 'capability', validFrom: past, validUntil: new Date(Date.now() - 1000).toISOString() })
    const due = await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.carol!, key: 'idt.body.read', kind: 'capability', state: 'scheduled', validFrom: past })
    const [a, b] = await Promise.all([sweepGrants(w.db.app, reg.read, w.db.customerId), sweepGrants(w.db.app, reg.read, w.db.customerId)])
    expect(a.expired + b.expired).toBe(1)
    expect((await events(w, expiring)).filter((e) => e.event_type.endsWith('expired.v1'))).toHaveLength(1)
    const ev = await events(w, due)
    expect(ev.map((e) => e.event_type)).toEqual(['de.gremion.idt.grant.granted.v1'])
    expect(Number(ev[0]!.aggregate_version)).toBeGreaterThan(1)
  })
  it('M-OFF-2: disabling publishing revokes the live grant (module_disabled) with an event; kernel grants untouched', async () => {
    const news = await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.alice!, key: 'newsletter.send', kind: 'capability' })
    const kernel = await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.alice!, key: 'idt.grant.read', kind: 'capability' })
    const r = makeRegistry(['votes', 'board', 'calendar', 'finance'])
    const res = await sweepGrants(w.db.app, r.read, w.db.customerId)
    expect(res.moduleRevoked).toBeGreaterThanOrEqual(1)
    const rows = await w.db.admin`SELECT grant_id::text, state, revoke_reason FROM idt.authz_grant WHERE grant_id IN (${news}::uuid, ${kernel}::uuid)`
    const by = Object.fromEntries(rows.map((x) => [x.grant_id, x]))
    expect(by[news]).toMatchObject({ state: 'revoked', revoke_reason: 'module_disabled' })
    expect(by[kernel]).toMatchObject({ state: 'active' })
    expect((await events(w, news)).map((e) => e.event_type)).toContain('de.gremion.idt.grant.revoked.v1')
    const cap = await w.db.admin`SELECT state FROM idt.capability WHERE capability_key = 'newsletter.send'`
    expect(cap[0]!.state).toBe('module_disabled')
  })
  it('M-OFF-4: enable -> disable -> enable does not resurrect the revoked grant', async () => {
    const all = makeRegistry(['publishing', 'votes', 'board', 'calendar', 'finance'])
    await sweepGrants(w.db.app, all.read, w.db.customerId)
    const cap = await w.db.admin`SELECT state FROM idt.capability WHERE capability_key = 'newsletter.send'`
    expect(cap[0]!.state).toBe('available')
    const revoked = await w.db.admin`SELECT count(*)::int AS n FROM idt.authz_grant WHERE capability_key = 'newsletter.send' AND state = 'revoked' AND revoke_reason = 'module_disabled'`
    expect(revoked[0]!.n).toBeGreaterThanOrEqual(1)
    const open = await w.db.admin`SELECT count(*)::int AS n FROM idt.authz_grant WHERE capability_key = 'newsletter.send' AND state IN ('active', 'scheduled')`
    expect(open[0]!.n).toBe(0)
    const d = await decide(w.db.app, all.read, { customerId: w.db.customerId, subject: { personId: w.persons.alice! }, bodyId: w.bodyA, capability: 'newsletter.send' })
    expect(d.allow).toBe(false)
  })
})

describe('PRD-IDN-002 revoke-all', () => {
  it('revokes 20 persons in one step-up window; all their decisions deny; 20 revoked.v1', async () => {
    const ids: string[] = []
    for (let i = 0; i < 20; i++) {
      const p = uuidv7()
      await insertPerson(w.db.admin, w.db.customerId, p, 'sub-bulk-' + i)
      await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: p, key: 'member' })
      ids.push(p)
    }
    const stale = await refused(revokeAllForPerson(w.db.app, deps, w.db.customerId, claims('sub-admin', { auth_time: NOW() - 900 }), ids[0]!))
    expect(stale.code).toBe('insufficient_user_authentication')
    const granter = claims('sub-admin')
    let revoked = 0
    for (const p of ids) revoked += (await revokeAllForPerson(w.db.app, deps, w.db.customerId, granter, p)).length
    expect(revoked).toBe(20)
    for (const p of ids) {
      expect((await decide(w.db.app, reg.read, { customerId: w.db.customerId, subject: { personId: p }, bodyId: w.bodyA, capability: 'gov.vote.cast' })).allow).toBe(false)
    }
    const ev = await w.db.admin`SELECT count(*)::int AS n FROM idt.outbox WHERE event_type = 'de.gremion.idt.grant.revoked.v1' AND data->>'subject_person_id' = ANY (${ids})`
    expect(ev[0]!.n).toBe(20)
  })
})

describe('TRD-084 listing', () => {
  it('each tenant enumerates only its own grants', async () => {
    const own = await listGrants(w.db.app, w.db.customerId)
    const other = await listGrants(w2.db.app, w2.db.customerId)
    expect(own.length).toBeGreaterThan(0)
    expect(other).toHaveLength(0)
  })
})

// Operator decision 2026-10-22: a customer-level role (council_admin / it_admin) held in the
// customer's verwaltung body is authority to grant body roles in ANY body of the SAME customer.
describe('customer-level granter authority across bodies of one customer', () => {
  const firstAdmin = (o: Record<string, unknown> = {}) =>
    ({ bodyId: w.bodyB, subjectPersonId: w.persons.alice!, grantKind: 'role' as const, key: 'body_admin', granterRole: 'council_admin', ...o })
  const decideManage = (personId: string, bodyId: string) =>
    decide(w.db.app, reg.read, { customerId: w.db.customerId, subject: { personId }, bodyId, capability: 'idt.grant.manage' })

  it('positive: council_admin held in the verwaltung grants the FIRST body_admin of another body (201, then that body_admin decides allow there)', async () => {
    expect((await decideManage(w.persons.alice!, w.bodyB)).allow).toBe(false)
    const g = await issueGrant(w.db.app, deps, w.db.customerId, claims('sub-carol'), firstAdmin())
    expect([g.state, g.role_key, g.body_id, g.granter_kind, g.source]).toEqual(['active', 'body_admin', w.bodyB, 'person', 'customer_admin'])
    expect(g.granted_by).toBe(w.persons.carol)
    expect((await decideManage(w.persons.alice!, w.bodyB)).allow).toBe(true)
  })
  it('positive: it_admin held in the verwaltung grants a body role in another body', async () => {
    const g = await issueGrant(w.db.app, deps, w.db.customerId, claims('sub-itv'), firstAdmin({ subjectPersonId: w.persons.bob!, key: 'member', granterRole: 'it_admin' }))
    expect([g.state, g.role_key, g.body_id]).toEqual(['active', 'member', w.bodyB])
  })
  it('positive: the same authority revokes a grant in another body', async () => {
    const g = await issueGrant(w.db.app, deps, w.db.customerId, claims('sub-carol'), firstAdmin({ subjectPersonId: w.persons.impostor!, key: 'member' }))
    const r = await revokeGrant(w.db.app, deps, w.db.customerId, claims('sub-carol'), g.grant_id)
    expect(r.state).toBe('revoked')
  })
  it('the customer role still has to be named truthfully (granterRole must be the one held)', async () => {
    const before = await count(w)
    const e = await refused(issueGrant(w.db.app, deps, w.db.customerId, claims('sub-carol'), firstAdmin({ subjectPersonId: w.persons.bob!, key: 'chair', granterRole: 'body_admin' })))
    expect(e.code).toBe('granter_role_mismatch')
    expect(await count(w)).toBe(before)
  })
  it('negative: the same role of ANOTHER customer is refused (own tenant only), 0 rows in both databases', async () => {
    const b1 = await count(w)
    const b3 = await count(w3)
    // ca3 holds council_admin in customer 3's verwaltung. Against customer 1 the token subject is no person there.
    const e1 = await refused(issueGrant(w.db.app, deps, w.db.customerId, claims('sub-ca3'), firstAdmin({ subjectPersonId: w.persons.bob! })))
    expect(e1.code).toBe('forbidden')
    // Against customer 3 itself, a body of customer 1 does not exist.
    const e3 = await refused(issueGrant(w3.db.app, deps, w3.db.customerId, claims('sub-ca3'), firstAdmin({ subjectPersonId: w3.persons.target3!, bodyId: w.bodyB })))
    expect(['forbidden', 'unknown_body']).toContain(e3.code)
    expect(await count(w)).toBe(b1)
    expect(await count(w3)).toBe(b3)
  })
  it('negative: a body_admin of body A cannot grant in body B', async () => {
    const before = await count(w)
    const e = await refused(issueGrant(w.db.app, deps, w.db.customerId, claims('sub-dave'), firstAdmin({ granterRole: 'body_admin', key: 'member', subjectPersonId: w.persons.bob! })))
    expect(e.code).toBe('forbidden')
    expect(await count(w)).toBe(before)
  })
  it('negative: a body_admin held in the verwaltung is a body role and still does not reach another body', async () => {
    const before = await count(w)
    const e = await refused(issueGrant(w.db.app, deps, w.db.customerId, claims('sub-admin'), firstAdmin({ granterRole: 'body_admin', key: 'member', subjectPersonId: w.persons.bob! })))
    expect(e.code).toBe('forbidden')
    expect(await count(w)).toBe(before)
  })
  it('negative: an it_admin held in a non-verwaltung body does not count, in its own body or another', async () => {
    const before = await count(w)
    for (const bodyId of [w.bodyA, w.bodyB]) {
      const e = await refused(issueGrant(w.db.app, deps, w.db.customerId, claims('sub-itfach'), firstAdmin({ bodyId, granterRole: 'it_admin', key: 'member', subjectPersonId: w.persons.bob! })))
      expect(e.code).toBe('forbidden')
    }
    expect(await count(w)).toBe(before)
  })
  it('negative: a finance-role holder in the verwaltung (no council_admin / it_admin) cannot grant in body B -> 403 (capability predicate)', async () => {
    const before = await count(w)
    for (const granterRole of ['finance', 'council_admin']) {
      const e = await refused(issueGrant(w.db.app, deps, w.db.customerId, claims('sub-fin'), firstAdmin({ granterRole, key: 'member', subjectPersonId: w.persons.bob! })))
      expect([e.code, e.status]).toEqual(['forbidden', 403])
    }
    expect(await count(w)).toBe(before)
  })
  it('negative: a revoked or an expired council_admin loses the customer-wide grant authority -> 403 (state / validity predicate)', async () => {
    // seeded here, not in beforeAll: the sweep test above counts every past-due grant of this world
    await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.verwaltung, personId: w.persons.caexp!, key: 'council_admin', validFrom: new Date(Date.now() - 172800000).toISOString(), validUntil: new Date(Date.now() - 86400000).toISOString() })
    const before = await count(w)
    for (const sub of ['sub-carev', 'sub-caexp']) {
      const e = await refused(issueGrant(w.db.app, deps, w.db.customerId, claims(sub), firstAdmin({ key: 'member', subjectPersonId: w.persons.bob! })))
      expect([e.code, e.status]).toEqual(['forbidden', 403])
    }
    expect(await count(w)).toBe(before)
  })
  it('negative: customer-wide authority is not a way around the privileged-grant step-up or the self-grant rule', async () => {
    const before = await count(w)
    const stale = await refused(issueGrant(w.db.app, deps, w.db.customerId, claims('sub-carol', { auth_time: NOW() - 900 }), firstAdmin()))
    expect(stale.code).toBe('insufficient_user_authentication')
    const self = await refused(issueGrant(w.db.app, deps, w.db.customerId, claims('sub-carol'), firstAdmin({ subjectPersonId: w.persons.carol! })))
    expect(self.code).toBe('self_grant')
    expect(await count(w)).toBe(before)
  })
})

// TRD-113 on the revoke side: a revoker may close only grants of roles its own role includes, the
// same rule as granting. Without it an it_admin (grants: body roles only) strips every council_admin.
describe('TRD-113 revoke honours the role-inclusion rule', () => {
  const seedCouncilAdmin = async (sub: string) => {
    const p = uuidv7()
    await insertPerson(w.db.admin, w.db.customerId, p, sub)
    const id = await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.verwaltung, personId: p, key: 'council_admin' })
    return { p, id }
  }
  const stateOf = async (id: string) => (await w.db.admin<{ state: string }[]>`SELECT state FROM idt.authz_grant WHERE grant_id = ${id}::uuid`)[0]!.state

  it('negative: an it_admin revoking a council_admin grant is 403 granter_role_mismatch, the grant stays active, no revoked event', async () => {
    const { id } = await seedCouncilAdmin('sub-ca-victim-1')
    const e = await refused(revokeGrant(w.db.app, deps, w.db.customerId, claims('sub-itv'), id))
    expect([e.code, e.status]).toEqual(['granter_role_mismatch', 403])
    expect(await stateOf(id)).toBe('active')
    expect((await events(w, id)).map((x) => x.event_type)).not.toContain('de.gremion.idt.grant.revoked.v1')
  })
  it('negative: the same through revoke-all (an it_admin cannot strip a person holding council_admin), nothing is closed', async () => {
    const { p, id } = await seedCouncilAdmin('sub-ca-victim-2')
    const e = await refused(revokeAllForPerson(w.db.app, deps, w.db.customerId, claims('sub-itv'), p))
    expect([e.code, e.status]).toEqual(['granter_role_mismatch', 403])
    expect(await stateOf(id)).toBe('active')
  })
  it('positive: an it_admin still revokes a body role (member) in any body; a council_admin revokes a council_admin', async () => {
    const m = await issueGrant(w.db.app, deps, w.db.customerId, claims('sub-carol'), { bodyId: w.bodyB, subjectPersonId: w.persons.bob!, grantKind: 'role', key: 'member', granterRole: 'council_admin' })
    expect((await revokeGrant(w.db.app, deps, w.db.customerId, claims('sub-itv'), m.grant_id)).state).toBe('revoked')
    const { id } = await seedCouncilAdmin('sub-ca-victim-3')
    expect((await revokeGrant(w.db.app, deps, w.db.customerId, claims('sub-carol'), id)).state).toBe('revoked')
  })
})
