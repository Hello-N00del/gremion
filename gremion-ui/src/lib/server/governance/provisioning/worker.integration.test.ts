import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../../db'
import { createOrgUnit, addOrgUnitMember } from '../org-units-db'
import { ensureResourceRow, getResource, markResourceFailed } from './ledger'
import { provisionOrgUnit } from './orchestrator'
import { enqueueMemberRemoveOps, getMemberOps } from './member-ops'
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

describe('provisioning worker', () => {
  beforeEach(async () => {
    const sql = getDb()
    await sql`TRUNCATE org_units RESTART IDENTITY CASCADE`
    await sql`DELETE FROM provisioning_resources`
    await sql`DELETE FROM provisioning_member_ops`
    await sql`DELETE FROM committee_elections`
    await sql`DELETE FROM org_units`
  })

  it('reconciles a unit that has a failed, due resource', async () => {
    const u = await createOrgUnit({
      name: 'U', description: null, parentId: null, kind: 'group',
      visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false
    })
    await ensureResourceRow(u.id, 'keycloak')
    await markResourceFailed(u.id, 'keycloak', 'transient') // attempts=1, backoff scheduled
    await getDb()`UPDATE provisioning_resources SET next_attempt_at = now() - interval '1 minute'
                  WHERE org_unit_id = ${u.id}` // make it due
    await provisionDuePending(allOk())
    expect((await getResource(u.id, 'keycloak'))?.status).toBe('ok')
  })

  it('the worker member-ops driver applies a due remove op and marks it ok', async () => {
    const unit = await seedUnit()
    await provisionOrgUnit(unit.id, allOk())
    let removed = 0
    const adapters: Adapters = {
      ...allOk(),
      keycloak: { ...allOk().keycloak, removeMember: async () => { removed++ } }
    }
    await getDb().begin(async (tx) => { await enqueueMemberRemoveOps(tx, unit.id, 'u-drain', ['keycloak']) })
    await provisionDuePending(adapters)
    expect(removed).toBe(1)
    expect((await getMemberOps(unit.id))[0].status).toBe('ok')
  })

  it('a remove op whose adapter reports 404 is treated as ok, not failed-forever', async () => {
    const unit = await seedUnit()
    await provisionOrgUnit(unit.id, allOk())
    const notFound: Adapters = {
      ...allOk(),
      keycloak: {
        ...allOk().keycloak,
        removeMember: async () => {
          const e: any = new Error('not found')
          e.status = 404
          throw e
        }
      }
    }
    await getDb().begin(async (tx) => { await enqueueMemberRemoveOps(tx, unit.id, 'u-gone', ['keycloak']) })
    await provisionDuePending(notFound)
    expect((await getMemberOps(unit.id))[0].status).toBe('ok')
  })

  it('a KC-shaped genuine 404 (plain Error, no status) is treated as ok', async () => {
    // Keycloak admin client throws plain Error with no .status property
    const unit = await seedUnit()
    await provisionOrgUnit(unit.id, allOk())
    const kcPlain404: Adapters = {
      ...allOk(),
      keycloak: {
        ...allOk().keycloak,
        removeMember: async () => { throw new Error('User not found') }
      }
    }
    await getDb().begin(async (tx) => { await enqueueMemberRemoveOps(tx, unit.id, 'u-kc-plain', ['keycloak']) })
    await provisionDuePending(kcPlain404)
    expect((await getMemberOps(unit.id))[0].status).toBe('ok')
  })

  it('an infra failure (ENOTFOUND) is marked failed, NEVER ok', async () => {
    const unit = await seedUnit()
    await provisionOrgUnit(unit.id, allOk())
    const dnsFailure: Adapters = {
      ...allOk(),
      keycloak: {
        ...allOk().keycloak,
        removeMember: async () => { throw new Error('getaddrinfo ENOTFOUND keycloak') }
      }
    }
    await getDb().begin(async (tx) => { await enqueueMemberRemoveOps(tx, unit.id, 'u-infra', ['keycloak']) })
    await provisionDuePending(dnsFailure)
    const op = (await getMemberOps(unit.id))[0]
    expect(op.status).toBe('failed')
    expect(op.attempts).toBe(1)
  })

  it('F3: a re-added membership supersedes the pending remove-op — adapter NOT called, op marked ok', async () => {
    // Scenario: remove-op is enqueued (membership hard-deleted at enqueue time),
    // then the user is legitimately re-added before the drain runs.
    // The supersession check must detect the re-existence of the membership row
    // and short-circuit without calling removeMember.
    const unit = await seedUnit()
    await provisionOrgUnit(unit.id, allOk())
    // Enqueue a remove op (simulating what removeMember does)
    await getDb().begin(async (tx) => { await enqueueMemberRemoveOps(tx, unit.id, 'u-supersede', ['keycloak']) })
    // Re-add the membership row (a later legitimate addMember happened after the remove)
    await addOrgUnitMember({ orgUnitId: unit.id, userKeycloakId: 'u-supersede', membershipType: 'unelected', termStart: null, termEnd: null })
    // Drain: the adapter should NOT be called because the membership now exists again
    let called = 0
    const counting: Adapters = {
      ...allOk(),
      keycloak: { ...allOk().keycloak, removeMember: async () => { called++ } }
    }
    await provisionDuePending(counting)
    expect(called).toBe(0)
    expect((await getMemberOps(unit.id)).find((o) => o.user_keycloak_id === 'u-supersede')?.status).toBe('ok')
  })

  it('a remove op drains even when the resource row is transiently failed (external_id retained)', async () => {
    const unit = await seedUnit()
    await provisionOrgUnit(unit.id, allOk()) // provisions → external_id set to 'kc1'
    // Simulate a transient outage: resource flips to failed but retains external_id
    await markResourceFailed(unit.id, 'keycloak', 'outage')
    let removed = 0
    const counting: Adapters = {
      ...allOk(),
      keycloak: { ...allOk().keycloak, removeMember: async () => { removed++ } }
    }
    await getDb().begin(async (tx) => { await enqueueMemberRemoveOps(tx, unit.id, 'u-failed-row', ['keycloak']) })
    await provisionDuePending(counting)
    expect(removed).toBe(1)
    expect((await getMemberOps(unit.id))[0].status).toBe('ok')
  })
})
