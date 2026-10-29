// Module-deselection coverage (operator decision 2026-10-21, plan section 2): M-OFF-1..4 for EVERY module the
// catalogue names, not only publishing. The PDP and the grant table are kernel substrate; a module's
// capabilities are decided against the registry read of THIS request, the sweep closes the live capability
// grants of a module that went off, and re-enabling never reopens them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CAPABILITIES, CATALOGUE_MODULE_KEYS } from '../../src/authz/catalogue.ts'
import { decide } from '../../src/authz/pdp.ts'
import { sweepGrants } from '../../src/authz/sweep.ts'
import { syncAuthzCatalogue } from '../../src/authz/sync.ts'
import { buildKernelDb, uuidv7 } from './db.ts'
import { ALL_MODULES, buildWorld, insertPerson, makeRegistry, moduleIds, seedGrant, type World } from './world.ts'

let w: World
let zero: World

beforeAll(async () => {
  w = await buildWorld('modoff', ALL_MODULES, [])
  zero = await buildWorld('modoffzero', [], [])
})
afterAll(async () => {
  await Promise.allSettled([w?.db.close(), zero?.db.close()])
})

const moduleCaps = CAPABILITIES.filter((c) => c.moduleKey !== null)
const kernelCaps = CAPABILITIES.filter((c) => c.moduleKey === null)
// one capability per module (the first the catalogue lists), keyed by module
const oneCapOf = new Map(CATALOGUE_MODULE_KEYS.map((m) => [m, moduleCaps.find((c) => c.moduleKey === m)!.key]))

async function person(world: World, name: string): Promise<string> {
  const id = uuidv7()
  await insertPerson(world.db.admin, world.db.customerId, id, 'sub-' + name + '-' + id.slice(-6))
  return id
}
const ask = (world: World, enabled: { read: (c: string) => Promise<ReadonlySet<string>> }, personId: string, capability: string) =>
  decide(world.db.app, enabled.read, { customerId: world.db.customerId, subject: { personId }, bodyId: world.bodyA, capability })
const events = (world: World, grantId: string) =>
  world.db.admin<{ event_type: string }[]>`SELECT event_type FROM idt.outbox WHERE aggregate_id = ${grantId}::uuid ORDER BY aggregate_version`

describe('the catalogue names every module the plan lists', () => {
  it('publishing, board, calendar, votes and finance each own at least one capability (not vacuous)', () => {
    expect([...oneCapOf.keys()].sort()).toEqual(['board', 'calendar', 'finance', 'publishing', 'votes'])
  })
})

describe('M-OFF-1 a customer with zero modules enabled', () => {
  it('M-OFF-1: seeding completed: every kernel capability is available, every module capability is module_disabled, none is missing', async () => {
    const rows = await zero.db.admin<{ capability_key: string; module_id: string | null; state: string }[]>`SELECT capability_key, module_id::text, state FROM idt.capability`
    expect(rows.length).toBe(CAPABILITIES.length)
    for (const c of kernelCaps) expect(rows.find((r) => r.capability_key === c.key)).toMatchObject({ module_id: null, state: 'available' })
    for (const c of moduleCaps) expect(rows.find((r) => r.capability_key === c.key)).toMatchObject({ state: 'module_disabled' })
  })
  it.each(moduleCaps.map((c) => [c.moduleKey!, c.key]))('M-OFF-1: %s / %s decides deny with module_not_enabled (a positive deny, not an exception)', async (_m, key) => {
    const none = makeRegistry([])
    const p = await person(zero, 'z')
    await seedGrant(zero.db.admin, zero.db.customerId, { bodyId: zero.bodyA, personId: p, key, kind: 'capability' })
    expect(await ask(zero, none, p, key)).toEqual({ allow: false, reason: 'module_not_enabled', grantIds: [] })
  })
  it.each(kernelCaps.map((c) => [c.key]))('M-OFF-1: kernel capability %s still decides allow for a granted person', async (key) => {
    const none = makeRegistry([])
    const p = await person(zero, 'k')
    const g = await seedGrant(zero.db.admin, zero.db.customerId, { bodyId: zero.bodyA, personId: p, key, kind: 'capability' })
    expect(await ask(zero, none, p, key)).toEqual({ allow: true, reason: 'granted', grantIds: [g] })
  })
})

describe('M-OFF-2 and M-OFF-4 per module (publishing, board, calendar, votes, finance)', () => {
  it.each([...oneCapOf.entries()])('%s (%s): the NEXT decision denies, the sweep revokes with module_disabled + event, kernel and sibling modules untouched, re-enable resurrects nothing', async (moduleKey, key) => {
    const p = await person(w, moduleKey)
    const live = await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: p, key, kind: 'capability' })
    const kernel = await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: p, key: 'idt.body.read', kind: 'capability' })
    const siblingModule = [...oneCapOf.keys()].find((m) => m !== moduleKey)!
    const siblingKey = oneCapOf.get(siblingModule)!
    const sibling = await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: p, key: siblingKey, kind: 'capability' })

    const reg = makeRegistry(ALL_MODULES)
    expect((await ask(w, reg, p, key)).allow).toBe(true)

    // module off: the very next decision denies (registry read per request, no cache)
    const readsBefore = reg.reads
    reg.set(ALL_MODULES.filter((m) => m !== moduleKey))
    expect(await ask(w, reg, p, key)).toMatchObject({ allow: false, reason: 'module_not_enabled' })
    expect(reg.reads).toBeGreaterThan(readsBefore)
    expect((await ask(w, reg, p, 'idt.body.read')).allow).toBe(true)
    expect((await ask(w, reg, p, siblingKey)).allow).toBe(true)

    // the sweep closes the live capability grant of THAT module only
    const res = await sweepGrants(w.db.app, reg.read, w.db.customerId)
    expect(res.moduleRevoked).toBeGreaterThanOrEqual(1)
    const state = async (id: string) => (await w.db.admin<{ state: string; revoke_reason: string | null }[]>`SELECT state, revoke_reason FROM idt.authz_grant WHERE grant_id = ${id}::uuid`)[0]!
    expect(await state(live)).toEqual({ state: 'revoked', revoke_reason: 'module_disabled' })
    expect(await state(kernel)).toMatchObject({ state: 'active' })
    expect(await state(sibling)).toMatchObject({ state: 'active' })
    expect((await events(w, live)).map((e) => e.event_type)).toContain('de.gremion.idt.grant.revoked.v1')
    expect((await events(w, kernel)).map((e) => e.event_type)).not.toContain('de.gremion.idt.grant.revoked.v1')
    expect((await w.db.admin`SELECT state FROM idt.capability WHERE capability_key = ${key}`)[0]!.state).toBe('module_disabled')

    // M-OFF-4: enable again, sweep again: the capability is available, the grant stays revoked, the person is still denied
    reg.set(ALL_MODULES)
    // before any sweep the registry alone is authoritative: the stale capability marker is not a second, slower module gate,
    // and the revoked grant is still not a grant (reason no_grant, not capability_unavailable)
    expect(await ask(w, reg, p, key)).toMatchObject({ allow: false, reason: 'no_grant' })
    await sweepGrants(w.db.app, reg.read, w.db.customerId)
    expect((await w.db.admin`SELECT state FROM idt.capability WHERE capability_key = ${key}`)[0]!.state).toBe('available')
    expect(await state(live)).toEqual({ state: 'revoked', revoke_reason: 'module_disabled' })
    expect(await ask(w, reg, p, key)).toMatchObject({ allow: false, reason: 'no_grant' })
    // and an explicit new grant is the only way back
    const again = await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: p, key, kind: 'capability' })
    expect(await ask(w, reg, p, key)).toEqual({ allow: true, reason: 'granted', grantIds: [again] })
  })

  it('a ROLE grant carrying a module capability denies that capability while the module is off and is not revoked (the role keeps its other capabilities); it applies again on re-enable', async () => {
    const p = await person(w, 'marketing')
    const role = await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: p, key: 'marketing' })
    const reg = makeRegistry(ALL_MODULES)
    expect((await ask(w, reg, p, 'newsletter.send')).allow).toBe(true)
    reg.set(ALL_MODULES.filter((m) => m !== 'publishing'))
    expect(await ask(w, reg, p, 'newsletter.send')).toMatchObject({ allow: false, reason: 'module_not_enabled' })
    await sweepGrants(w.db.app, reg.read, w.db.customerId)
    expect((await w.db.admin`SELECT state FROM idt.authz_grant WHERE grant_id = ${role}::uuid`)[0]!.state).toBe('active')
    reg.set(ALL_MODULES)
    // immediately, without waiting for a sweep to flip the capability marker back
    expect((await ask(w, reg, p, 'newsletter.send')).allow).toBe(true)
  })
})

describe('M-OFF-3 a module absent from the build', () => {
  it('sync with no registry row for a module succeeds, names the skipped capabilities, and writes no row for it (nothing was synced before: the table starts empty)', async () => {
    const db = await buildKernelDb('modoffabsent')
    try {
      const absent = new Map([...moduleIds].filter(([k]) => k !== 'finance' && k !== 'calendar'))
      const r = await syncAuthzCatalogue(db.app, { customerId: db.customerId, moduleIds: absent, enabledModules: new Set(['publishing']) })
      const missing = moduleCaps.filter((c) => c.moduleKey === 'finance' || c.moduleKey === 'calendar').map((c) => c.key)
      expect(missing.length).toBeGreaterThan(0)
      for (const k of missing) expect(r.skipped).toContain(k)
      const rows = await db.admin<{ capability_key: string }[]>`SELECT capability_key FROM idt.capability WHERE capability_key = ANY (${db.admin.array(missing)}::text[])`
      expect(rows).toEqual([])
      // every other capability is there: the absent module cost nothing else
      expect((await db.admin`SELECT count(*)::int AS n FROM idt.capability`)[0]!.n).toBe(CAPABILITIES.length - missing.length)
      // a decision for the absent module's capability is a positive deny, not an error
      const d = await decide(db.app, makeRegistry(['publishing']).read, { customerId: db.customerId, subject: { personId: uuidv7() }, bodyId: uuidv7(), capability: missing[0]! })
      expect(d.allow).toBe(false)
    } finally {
      await db.close()
    }
  })
})
