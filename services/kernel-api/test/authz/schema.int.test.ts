// TDD 1/2/13: constraints, guard refusals, catalogue sync (idempotent, module-aware).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CAPABILITIES, ROLES } from '../../src/authz/catalogue.ts'
import { syncAuthzCatalogue } from '../../src/authz/sync.ts'
import { uuidv7 } from './db.ts'
import { ALL_MODULES, buildWorld, moduleIds, seedGrant, type World } from './world.ts'

let w: World
beforeAll(async () => {
  w = await buildWorld('schema')
})
afterAll(async () => {
  await w?.db.close()
})

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'ok'
  } catch (e) {
    return (e as { code?: string }).code ?? 'err'
  }
}

const constraint = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'ok'
  } catch (e) {
    const x = e as { code?: string; constraint_name?: string }
    return `${x.code}:${x.constraint_name}`
  }
}

describe('schema constraints', () => {
  it('finance never holds newsletter.send (23514)', async () => {
    const c = await code(w.db.admin`UPDATE idt.role SET capability_keys = array_append(capability_keys, 'newsletter.send') WHERE role_key = 'finance'`)
    expect(c).toBe('23514')
  })
  it('granter_kind customer_admin is a CHECK violation; it is a SOURCE value (guard 8)', async () => {
    // the NAMED granter CHECK must be the refusing one (created_by_kind's own CHECK would also trip, so the code alone proves nothing)
    const bad = constraint(seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.alice!, key: 'member', granterKind: 'customer_admin' as never }))
    expect(await bad).toBe('23514:authz_grant_granter_check')
    const ok = await code(seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.alice!, key: 'helper', granterKind: 'person', source: 'customer_admin' }))
    expect(ok).toBe('ok')
  })
  it('meeting_role without valid_until or meeting resource is refused (23514)', async () => {
    const m = uuidv7()
    expect(await code(seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.alice!, key: 'chair', source: 'meeting_role', resource: { kind: 'meeting', id: m } }))).toBe('23514')
    expect(await code(seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.alice!, key: 'chair', source: 'meeting_role', resource: { kind: 'meeting', id: m }, validUntil: new Date(Date.now() + 3_600_000).toISOString() }))).toBe('ok')
  })
  it('a closed grant cannot reopen and a grant is never edited in place (guard)', async () => {
    const id = await seedGrant(w.db.admin, w.db.customerId, { bodyId: w.bodyA, personId: w.persons.bob!, key: 'member' })
    expect(await code(w.db.admin`UPDATE idt.authz_grant SET role_key = 'chair' WHERE grant_id = ${id}::uuid`)).toBe('23514')
    await w.db.admin`UPDATE idt.authz_grant SET state='revoked', revoked_at=now(), revoked_by_kind='system', revoke_reason='manual', updated_by_kind='system', updated_by=NULL WHERE grant_id = ${id}::uuid`
    expect(await code(w.db.admin`UPDATE idt.authz_grant SET state='active', revoked_at=NULL, revoked_by_kind=NULL, revoke_reason=NULL WHERE grant_id = ${id}::uuid`)).toBe('23514')
  })
  it('RLS: the app role sees nothing without the customer context', async () => {
    const rows = await w.db.app`SELECT count(*)::int AS n FROM idt.authz_grant`
    expect(rows[0]!.n).toBe(0)
  })
})

describe('catalogue sync', () => {
  it('writes every role and every module-known capability; kernel capabilities have no module', async () => {
    const roles = await w.db.admin`SELECT count(*)::int AS n FROM idt.role`
    const caps = await w.db.admin`SELECT capability_key, module_id, state FROM idt.capability`
    expect(roles[0]!.n).toBe(ROLES.length)
    expect(caps.length).toBe(CAPABILITIES.length)
    for (const c of caps) expect(c.module_id === null).toBe(String(c.capability_key).startsWith('idt.'))
  })
  it('re-sync is a no-op (row_version unchanged)', async () => {
    const before = await w.db.admin`SELECT sum(row_version)::int AS v FROM idt.capability`
    await syncAuthzCatalogue(w.db.app, { customerId: w.db.customerId, moduleIds, enabledModules: new Set(ALL_MODULES) })
    const after = await w.db.admin`SELECT sum(row_version)::int AS v FROM idt.capability`
    expect(after[0]!.v).toBe(before[0]!.v)
  })
  it('M-OFF-3: a module absent from the registry gets no capability row and sync succeeds', async () => {
    const small = new Map([...moduleIds].filter(([k]) => k !== 'board'))
    const r = await syncAuthzCatalogue(w.db.app, { customerId: w.db.customerId, moduleIds: small, enabledModules: new Set(['publishing', 'votes']) })
    expect(r.skipped).toContain('brd.card.own')
    const dangling = await w.db.admin`SELECT count(*)::int AS n FROM idt.capability WHERE capability_key LIKE 'brd.%' AND state = 'available'`
    expect(dangling[0]!.n).toBe(0)
  })
})
