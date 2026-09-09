import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../../db'
import { createOrgUnit } from '../org-units-db'
import { ensureResourceRow, enqueueResources, getResource, getResources, listDueOrgUnitIds } from './ledger'
import { provisionOrgUnit, deprovisionOrgUnit, wantedSubsystems } from './orchestrator'
import type { Adapters, ProvisioningSubsystem } from './types'

function okAdapter(name: ProvisioningSubsystem['name'], id: string): ProvisioningSubsystem {
  return {
    name,
    async ensureResource() { return { externalId: id } },
    async removeResource() {},
    async addMember() {}, async removeMember() {},
    async reconcileMembers() {}
  }
}
function failingAdapter(name: ProvisioningSubsystem['name']): ProvisioningSubsystem {
  return {
    name,
    async ensureResource() { throw new Error('subsystem down') },
    async removeResource() {},
    async addMember() {}, async removeMember() {},
    async reconcileMembers() {}
  }
}
const allOk = (): Adapters => ({
  keycloak: okAdapter('keycloak', 'kc1'),
  matrix: okAdapter('matrix', '!r:s'),
  nextcloud: okAdapter('nextcloud', '7:ou-x')
})

async function unit(over = {}) {
  return createOrgUnit({
    name: 'U', description: null, parentId: null, kind: 'committee',
    visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true, ...over
  })
}

describe('orchestrator.provisionOrgUnit', () => {
  beforeEach(async () => {
    const sql = getDb()
    await sql`TRUNCATE org_units RESTART IDENTITY CASCADE`
    await sql`DELETE FROM provisioning_resources`
    await sql`DELETE FROM org_unit_members`
    await sql`DELETE FROM committee_elections`
    await sql`DELETE FROM org_units`
  })

  it('provisions all three subsystems and reports ok', async () => {
    const u = await unit()
    const report = await provisionOrgUnit(u.id, allOk())
    expect(report.overall).toBe('ok')
    expect((await getResource(u.id, 'keycloak'))?.status).toBe('ok')
  })

  it('Keycloak failure makes the report fail', async () => {
    const u = await unit()
    const report = await provisionOrgUnit(u.id, { ...allOk(), keycloak: failingAdapter('keycloak') })
    expect(report.overall).toBe('failed')
    expect((await getResource(u.id, 'keycloak'))?.status).toBe('failed')
  })

  it('a Matrix failure is degraded, not failed', async () => {
    const u = await unit()
    const report = await provisionOrgUnit(u.id, { ...allOk(), matrix: failingAdapter('matrix') })
    expect(report.overall).toBe('degraded')
    expect((await getResource(u.id, 'matrix'))?.next_attempt_at).not.toBeNull()
  })

  it('skips Matrix when wants_matrix_room is false', async () => {
    const u = await unit({ wantsMatrixRoom: false })
    const report = await provisionOrgUnit(u.id, allOk())
    expect(report.subsystems.find((s) => s.subsystem === 'matrix')?.status).toBe('skipped')
  })

  it('re-running is idempotent — already-ok resources are not recreated', async () => {
    const u = await unit()
    await provisionOrgUnit(u.id, allOk())
    let calls = 0
    const base = okAdapter('keycloak', 'kc1')
    const wrapped: ProvisioningSubsystem = { ...base, async ensureResource(...a) { calls++; return base.ensureResource(...a) } }
    await provisionOrgUnit(u.id, { ...allOk(), keycloak: wrapped })
    expect(calls).toBe(0)
  })

  it('deprovisionOrgUnit tears down every provisioned resource', async () => {
    const u = await unit()
    await provisionOrgUnit(u.id, allOk())
    const report = await deprovisionOrgUnit(u.id, allOk())
    expect(report.overall).toBe('ok')
  })

  it('two concurrent provisionOrgUnit calls create exactly one resource per subsystem', async () => {
    const u = await unit()
    let kcCalls = 0
    const counting: ProvisioningSubsystem = {
      ...okAdapter('keycloak', 'kc-1'),
      async ensureResource() {
        kcCalls++
        await new Promise((r) => setTimeout(r, 30))
        return { externalId: 'kc-1' }
      }
    }
    const adapters: Adapters = {
      keycloak: counting,
      matrix: okAdapter('matrix', 'm-1'),
      nextcloud: okAdapter('nextcloud', 'nc-1')
    }
    await ensureResourceRow(u.id, 'keycloak')
    await Promise.all([provisionOrgUnit(u.id, adapters), provisionOrgUnit(u.id, adapters)])
    expect(kcCalls).toBe(1)
  })

  it('atomic enqueue: org_unit + pending rows commit together and the unit is immediately worker-due', async () => {
    let unitId = ''
    await getDb().begin(async (tx) => {
      const unit = await createOrgUnit(tx, {
        name: 'Atomic', kind: 'committee', visibility: 'all_members',
        wantsMatrixRoom: true, wantsNextcloudFolder: true,
        description: null, parentId: null
      })
      unitId = unit.id
      await enqueueResources(tx, unit.id, wantedSubsystems(unit))
    })
    expect((await listDueOrgUnitIds()).includes(unitId)).toBe(true)
    expect((await getResources(unitId)).map((r) => r.subsystem).sort()).toEqual(['keycloak', 'matrix', 'nextcloud'])
  })

  it('deprovisionOrgUnit removes the Keycloak parent LAST (after Matrix/Nextcloud)', async () => {
    const u = await unit()
    await provisionOrgUnit(u.id, allOk())
    const order: string[] = []
    const rec = (name: 'keycloak' | 'matrix' | 'nextcloud') => ({
      ...okAdapter(name, `${name}-1`),
      async removeResource(_id: string) { order.push(name) }
    })
    await deprovisionOrgUnit(u.id, {
      keycloak: rec('keycloak'),
      matrix: rec('matrix'),
      nextcloud: rec('nextcloud')
    } as Adapters)
    expect(order.indexOf('keycloak')).toBe(order.length - 1)
  })
})
