// TDD 3-5, 9-10, 13 + module-OFF lines M-OFF-1/2: the PDP over a (tenant, body)
// grant table. Every deny is paired with an allow in the same data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decide, type DecideInput } from '../../src/authz/pdp.ts'
import { uuidv7 } from './db.ts'
import { buildWorld, insertPerson, makeRegistry, seedGrant, type World } from './world.ts'

let w: World
let w2: World
const reg = makeRegistry(['publishing', 'votes', 'board', 'calendar', 'finance'])
const reg2 = makeRegistry(['publishing', 'votes', 'board', 'calendar', 'finance'])

beforeAll(async () => {
  w = await buildWorld('pdp')
  w2 = await buildWorld('pdp2')
})
afterAll(async () => {
  await Promise.allSettled([w?.db.close(), w2?.db.close()])
})

const ask = (world: World, registry: typeof reg, who: string, capability: string, o: Partial<DecideInput> = {}) =>
  decide(world.db.app, registry.read, { customerId: world.db.customerId, subject: { personId: world.persons[who]! }, bodyId: world.bodyA, capability, ...o })

const future = (ms: number) => new Date(Date.now() + ms).toISOString()

describe('body (TRD-429)', () => {
  it('a body-A grant allows in A and denies in B', async () => {
    const id = await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.alice!, key: 'member' })
    const a = await ask(w, reg, 'alice', 'gov.vote.cast')
    expect(a).toEqual({ allow: true, reason: 'granted', grantIds: [id] })
    const b = await ask(w, reg, 'alice', 'gov.vote.cast', { bodyId: w.bodyB })
    expect(b.allow).toBe(false)
    expect(b.reason).toBe('no_grant')
  })
})

describe('validity', () => {
  it('expired (state active, valid_until passed) denies; the open twin allows', async () => {
    const past = new Date(Date.now() - 7_200_000).toISOString()
    await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.bob!, key: 'idt.body.read', kind: 'capability', validFrom: past, validUntil: new Date(Date.now() - 60_000).toISOString() })
    expect((await ask(w, reg, 'bob', 'idt.body.read')).allow).toBe(false)
    await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.bob!, key: 'idt.body.read', kind: 'capability', validFrom: past, validUntil: future(3_600_000) })
    expect((await ask(w, reg, 'bob', 'idt.body.read')).allow).toBe(true)
  })
  it('a future valid_from denies, the started twin allows', async () => {
    await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.bob!, key: 'idt.grant.read', kind: 'capability', state: 'scheduled', validFrom: future(3_600_000) })
    expect((await ask(w, reg, 'bob', 'idt.grant.read')).allow).toBe(false)
    await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.bob!, key: 'idt.grant.read', kind: 'capability', validFrom: new Date(Date.now() - 1000).toISOString() })
    expect((await ask(w, reg, 'bob', 'idt.grant.read')).allow).toBe(true)
  })
})

describe('PRD-IDN-007', () => {
  it('newsletter.send alone allows; finance alone denies', async () => {
    const p = await seedPerson(w, 'carol')
    const q = await seedPerson(w, 'dave')
    await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: p, key: 'newsletter.send', kind: 'capability' })
    await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.verwaltung, personId: q, key: 'finance' })
    expect((await decide(w.db.app, reg.read, { customerId: w.db.customerId, subject: { personId: p }, bodyId: w.bodyA, capability: 'newsletter.send' })).allow).toBe(true)
    const f = await decide(w.db.app, reg.read, { customerId: w.db.customerId, subject: { personId: q }, bodyId: w.verwaltung, capability: 'newsletter.send' })
    expect(f).toMatchObject({ allow: false, reason: 'no_grant' })
    expect((await decide(w.db.app, reg.read, { customerId: w.db.customerId, subject: { personId: q }, bodyId: w.verwaltung, capability: 'fin.ledger.read' })).allow).toBe(true)
  })
})

describe('TRD-084 tenants', () => {
  it('a grant in tenant A has no effect in tenant B', async () => {
    const sub = 'sub-shared'
    const pa = uuidv7()
    const pb = uuidv7()
    await insertPerson(w.db.admin, w.db.customerId, pa, sub)
    await insertPerson(w2.db.admin, w2.db.customerId, pb, sub)
    await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: pa, key: 'member' })
    const inA = await decide(w.db.app, reg.read, { customerId: w.db.customerId, subject: { sub }, bodyId: w.bodyA, capability: 'gov.vote.cast' })
    const inB = await decide(w2.db.app, reg2.read, { customerId: w2.db.customerId, subject: { sub }, bodyId: w2.bodyA, capability: 'gov.vote.cast' })
    expect(inA.allow).toBe(true)
    expect(inB.allow).toBe(false)
  })
  it('the app role sees only its own customer rows (empty RLS is not a deny of another tenant)', async () => {
    const rows = await w.db.app.begin(async (tx) => {
      await tx`SELECT set_config('gremion.customer_id', ${w2.db.customerId}, true)`
      return tx`SELECT count(*)::int AS n FROM idt.authz_grant`
    })
    expect(rows[0]!.n).toBe(0)
  })
})

describe('per-meeting roles', () => {
  it('a meeting_role on M1 allows M1 only; M2 and standing deny', async () => {
    const m1 = uuidv7()
    const m2 = uuidv7()
    const p = await seedPerson(w, 'erin')
    await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: p, key: 'protocol_taker', source: 'meeting_role', resource: { kind: 'meeting', id: m1 }, validUntil: future(3_600_000) })
    const q = (o: Partial<DecideInput>) => decide(w.db.app, reg.read, { customerId: w.db.customerId, subject: { personId: p }, bodyId: w.bodyA, capability: 'gov.protocol.take', ...o })
    expect((await q({ resource: { kind: 'meeting', id: m1 } })).allow).toBe(true)
    expect((await q({ resource: { kind: 'meeting', id: m2 } })).allow).toBe(false)
    expect((await q({})).allow).toBe(false)
  })
})

describe('helper vs member (TRD-116)', () => {
  it('helper may propose an agenda item and own a card, may not vote, count quorum or hold office; member may', async () => {
    const h = await seedPerson(w, 'hank')
    const m = await seedPerson(w, 'mia')
    await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: h, key: 'helper' })
    await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: m, key: 'member' })
    const can = async (p: string, c: string) => (await decide(w.db.app, reg.read, { customerId: w.db.customerId, subject: { personId: p }, bodyId: w.bodyA, capability: c })).allow
    for (const c of ['gov.agenda_item.propose', 'brd.card.own']) expect(await can(h, c)).toBe(true)
    for (const c of ['gov.vote.cast', 'gov.quorum.count', 'gov.office.hold']) {
      expect(await can(h, c)).toBe(false)
      expect(await can(m, c)).toBe(true)
    }
  })
})

describe('customer-level roles only in verwaltung', () => {
  it('finance (customer scope) allows in the verwaltung body, denies in a fachschaft body', async () => {
    const p = await seedPerson(w, 'fred')
    await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.verwaltung, personId: p, key: 'finance' })
    await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: p, key: 'finance' })
    const at = (bodyId: string) => decide(w.db.app, reg.read, { customerId: w.db.customerId, subject: { personId: p }, bodyId, capability: 'fin.ledger.read' })
    expect((await at(w.verwaltung)).allow).toBe(true)
    expect((await at(w.bodyA)).allow).toBe(false)
  })
})

describe('module OFF (operator decision 2026-10-21)', () => {
  it('M-OFF-1: zero modules enabled: kernel capability still allows, module capabilities deny with module_not_enabled', async () => {
    const wz = await buildWorld('pdpzero', [])
    const none = makeRegistry([])
    try {
      await seedGrant(wz.db.admin, wz.db.customerId, { bodyId: wz.bodyA, personId: wz.persons.alice!, key: 'body_admin' })
      await seedGrant(wz.db.admin, wz.db.customerId, { bodyId: wz.bodyA, personId: wz.persons.alice!, key: 'newsletter.send', kind: 'capability' })
      const kernel = await decide(wz.db.app, none.read, { customerId: wz.db.customerId, subject: { personId: wz.persons.alice! }, bodyId: wz.bodyA, capability: 'idt.grant.manage' })
      expect(kernel.allow).toBe(true)
      const mod = await decide(wz.db.app, none.read, { customerId: wz.db.customerId, subject: { personId: wz.persons.alice! }, bodyId: wz.bodyA, capability: 'newsletter.send' })
      expect(mod).toEqual({ allow: false, reason: 'module_not_enabled', grantIds: [] })
    } finally {
      await wz.db.close()
    }
  })
  it('M-OFF-2: disabling publishing denies on the NEXT decision (no cache); kernel decisions unchanged', async () => {
    const p = await seedPerson(w, 'gina')
    await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: p, key: 'newsletter.send', kind: 'capability' })
    await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: p, key: 'idt.body.read', kind: 'capability' })
    const r = makeRegistry(['publishing', 'votes'])
    const q = (c: string) => decide(w.db.app, r.read, { customerId: w.db.customerId, subject: { personId: p }, bodyId: w.bodyA, capability: c })
    expect((await q('newsletter.send')).allow).toBe(true)
    const reads = r.reads
    r.set(['votes'])
    expect(await q('newsletter.send')).toMatchObject({ allow: false, reason: 'module_not_enabled' })
    expect(r.reads).toBeGreaterThan(reads)
    expect((await q('idt.body.read')).allow).toBe(true)
  })
  it('the decision path makes no outbound call: no module is reachable in this run (only the registry read exists)', async () => {
    const calls: string[] = []
    const g = globalThis.fetch
    globalThis.fetch = (async (...a: unknown[]) => {
      calls.push(String(a[0]))
      throw new Error('outbound call')
    }) as never
    try {
      await ask(w, reg, 'alice', 'gov.vote.cast')
    } finally {
      globalThis.fetch = g
    }
    expect(calls).toEqual([])
  })
})

async function seedPerson(world: World, name: string): Promise<string> {
  const id = uuidv7()
  await insertPerson(world.db.admin, world.db.customerId, id, 'sub-' + name)
  return id
}
