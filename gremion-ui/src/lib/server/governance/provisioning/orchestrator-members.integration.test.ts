import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../../db'
import { createOrgUnit, addOrgUnitMember, listOrgUnitMembers, isMemberOf } from '../org-units-db'
import { provisionOrgUnit, addMember, removeMember, removeUserEverywhere } from './orchestrator'
import { getMemberOps } from './member-ops'
import { markResourceFailed } from './ledger'
import { provisionDuePending } from './worker'
import type { Adapters, ProvisioningSubsystem } from './types'

function okAdapter(name: ProvisioningSubsystem['name'], id: string): ProvisioningSubsystem {
  return {
    name,
    async ensureResource() { return { externalId: id } },
    async removeResource() {}, async addMember() {}, async removeMember() {},
    async reconcileMembers() {}
  }
}
const allOk = (): Adapters => ({
  keycloak: okAdapter('keycloak', 'kc1'),
  matrix: okAdapter('matrix', '!r:s'),
  nextcloud: okAdapter('nextcloud', '7:ou')
})
async function seedUnit() {
  return createOrgUnit({
    name: 'W', description: null, parentId: null, kind: 'group',
    visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false
  })
}

function recordingAdapter(name: ProvisioningSubsystem['name'], id: string) {
  const added: string[] = []
  const removed: string[] = []
  const sub: ProvisioningSubsystem = {
    name,
    async ensureResource() { return { externalId: id } },
    async removeResource() {},
    async addMember(_e, u) { added.push(u) },
    async removeMember(_e, u) { removed.push(u) },
    async reconcileMembers() {}
  }
  return { sub, added, removed }
}

describe('orchestrator member operations', () => {
  beforeEach(async () => {
    const sql = getDb()
    await sql`TRUNCATE org_units RESTART IDENTITY CASCADE`
    await sql`DELETE FROM provisioning_resources`
    await sql`DELETE FROM org_unit_members`
    await sql`DELETE FROM committee_elections`
    await sql`DELETE FROM org_units`
  })

  it('addMember inserts the row and fans out to every ok subsystem', async () => {
    const u = await createOrgUnit({
      name: 'U', description: null, parentId: null, kind: 'committee',
      visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true
    })
    const kc = recordingAdapter('keycloak', 'kc1')
    const mx = recordingAdapter('matrix', '!r:s')
    const nc = recordingAdapter('nextcloud', '7:ou-x')
    const adapters: Adapters = { keycloak: kc.sub, matrix: mx.sub, nextcloud: nc.sub }
    await provisionOrgUnit(u.id, adapters)

    const report = await addMember(u.id, 'user-1', 'elected', '2026-01-01', '2027-01-01', adapters)
    expect(report.overall).toBe('ok')
    expect(await isMemberOf(u.id, 'user-1')).toBe(true)
    expect(kc.added).toContain('user-1')
    expect(mx.added).toContain('user-1')
    expect(nc.added).toContain('user-1')
    expect((await listOrgUnitMembers(u.id))[0].membership_type).toBe('elected')
  })

  it('removeMember deletes the row and removes from every subsystem', async () => {
    const u = await createOrgUnit({
      name: 'U', description: null, parentId: null, kind: 'group',
      visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true
    })
    const kc = recordingAdapter('keycloak', 'kc1')
    const mx = recordingAdapter('matrix', '!r:s')
    const nc = recordingAdapter('nextcloud', '7:ou-x')
    const adapters: Adapters = { keycloak: kc.sub, matrix: mx.sub, nextcloud: nc.sub }
    await provisionOrgUnit(u.id, adapters)
    await addMember(u.id, 'user-1', 'unelected', null, null, adapters)

    await removeMember(u.id, 'user-1', adapters)
    expect(await isMemberOf(u.id, 'user-1')).toBe(false)
    expect(kc.removed).toContain('user-1')
  })

  it('removeUserEverywhere clears the user from all org-units', async () => {
    const a = await createOrgUnit({
      name: 'A', description: null, parentId: null, kind: 'group',
      visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false
    })
    const kc = recordingAdapter('keycloak', 'kc1')
    const adapters: Adapters = { keycloak: kc.sub, matrix: kc.sub, nextcloud: kc.sub }
    await provisionOrgUnit(a.id, adapters)
    await addMember(a.id, 'user-9', 'employee', null, null, adapters)
    await removeUserEverywhere('user-9', adapters)
    expect(await isMemberOf(a.id, 'user-9')).toBe(false)
  })

  it('#185: a fanOut throw on remove still leaves a durable remove-op and deletes the membership', async () => {
    const u = await createOrgUnit({
      name: 'U185', description: null, parentId: null, kind: 'committee',
      visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false
    })
    const kc = recordingAdapter('keycloak', 'kc-185')
    const adapters: Adapters = { keycloak: kc.sub, matrix: kc.sub, nextcloud: kc.sub }
    await provisionOrgUnit(u.id, adapters)
    await addMember(u.id, 'u-185', 'unelected', null, null, adapters)

    const throwingKc: ProvisioningSubsystem = {
      ...kc.sub,
      removeMember: async () => { throw new Error('kc down') }
    }
    const throwingAdapters: Adapters = { keycloak: throwingKc, matrix: kc.sub, nextcloud: kc.sub }
    await removeMember(u.id, 'u-185', throwingAdapters) // must not throw out

    expect(await isMemberOf(u.id, 'u-185')).toBe(false)
    expect((await getMemberOps(u.id)).filter((o) => o.user_keycloak_id === 'u-185').length).toBeGreaterThan(0)
  })

  it('F1: enqueue filter uses external_id not status — a failed-row resource still gets a remove-op and drains ok', async () => {
    // Scenario: unit is provisioned ok, then resource flips to failed (transient outage)
    // while the user is still a member. removeMember should enqueue the op even though
    // the resource row status is 'failed' (it retains external_id → live external resource).
    const u = await createOrgUnit({
      name: 'F1Unit', description: null, parentId: null, kind: 'committee',
      visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false
    })
    const kc = recordingAdapter('keycloak', 'kc-f1')
    const adapters: Adapters = { keycloak: kc.sub, matrix: kc.sub, nextcloud: kc.sub }
    await provisionOrgUnit(u.id, adapters)
    await addMember(u.id, 'user-f1', 'unelected', null, null, adapters)

    // Simulate a transient outage on keycloak: resource retains external_id but status=failed
    await markResourceFailed(u.id, 'keycloak', 'outage')

    // removeMember with a throwing KC adapter — fanOut will fail, but the enqueue must
    // still fire because external_id is present regardless of status
    const throwingAdapters: Adapters = {
      keycloak: { ...kc.sub, removeMember: async () => { throw new Error('kc down') } },
      matrix: kc.sub,
      nextcloud: kc.sub,
    }
    await removeMember(u.id, 'user-f1', throwingAdapters) // must not throw

    // The member-op row for keycloak must exist (the enqueue fired despite failed status)
    const ops = (await getMemberOps(u.id)).filter((o) => o.user_keycloak_id === 'user-f1' && o.subsystem === 'keycloak')
    expect(ops.length).toBeGreaterThan(0)

    // Drain with ok adapters: the drain should call removeMember and converge the op to ok
    const drainKc = recordingAdapter('keycloak', 'kc-f1')
    const drainAdapters: Adapters = { keycloak: drainKc.sub, matrix: kc.sub, nextcloud: kc.sub }
    await provisionDuePending(drainAdapters)
    expect(drainKc.removed).toContain('user-f1')
    expect((await getMemberOps(u.id)).find((o) => o.user_keycloak_id === 'user-f1')?.status).toBe('ok')
  })

  it('an early throw inside fanOut on ADD leaves the unit due so the worker re-drives reconcileMembers', async () => {
    // Simulate the gap: membership row is persisted (e.g. addMember's addOrgUnitMember succeeded)
    // but fanOut's getResources threw before propagating — leaving the resource in a failed/due state.
    // The self-heal path: worker picks up the unit (it has a due non-ok resource) and calls
    // provisionOrgUnit → reconcileMembers with the full current member list.
    const unit = await seedUnit()
    await provisionOrgUnit(unit.id, allOk())
    // Persist the membership directly (as addMember would have before fanOut blew up)
    await addOrgUnitMember({ orgUnitId: unit.id, userKeycloakId: 'u-add', membershipType: 'unelected', termStart: null, termEnd: null })
    // Simulate the resource being non-ok (as if markResourceFailed was called by the per-adapter
    // catch, or as if the unit was never fully synced after the member insert)
    await markResourceFailed(unit.id, 'keycloak', 'transient during add')
    // Make the resource immediately due (bypass backoff)
    await getDb()`UPDATE provisioning_resources SET next_attempt_at = now() - interval '1 minute'
                  WHERE org_unit_id = ${unit.id}`
    let added: string[] = []
    const adapters: Adapters = {
      ...allOk(),
      keycloak: { ...allOk().keycloak, reconcileMembers: async (_id: string, ids: string[]) => { added = ids } }
    }
    await provisionDuePending(adapters)
    expect(added).toContain('u-add')
  })
})
