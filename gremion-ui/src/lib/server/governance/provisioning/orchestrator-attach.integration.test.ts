// FLOW-MSG-001 (TASK-009 lane B): T1-T5 for attachSubsystem / releaseSubsystem.
import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../../db'
import { createOrgUnit } from '../org-units-db'
import { getResource, listDueOrgUnitIds } from './ledger'
import {
  attachSubsystem, releaseSubsystem, provisionOrgUnit, deprovisionOrgUnit, addMember, removeMember
} from './orchestrator'
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
const allOk = (): Adapters => ({
  keycloak: okAdapter('keycloak', 'kc1'),
  matrix: okAdapter('matrix', '!r:s'),
  nextcloud: okAdapter('nextcloud', '7:ou-x')
})

async function unit(over = {}) {
  return createOrgUnit({
    name: 'U', description: null, parentId: null, kind: 'committee',
    visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false, ...over
  })
}

describe('orchestrator.attachSubsystem / releaseSubsystem', () => {
  beforeEach(async () => {
    const sql = getDb()
    await sql`TRUNCATE org_units RESTART IDENTITY CASCADE`
    await sql`DELETE FROM provisioning_resources`
    await sql`DELETE FROM org_unit_members`
    await sql`DELETE FROM committee_elections`
    await sql`DELETE FROM org_units`
  })

  it('T1: attachSubsystem sets the flag, creates one pending row, calls ensureResource once; a concurrent second call still calls it once total', async () => {
    const u = await unit()
    let calls = 0
    const base = okAdapter('matrix', '!r:s')
    const counting: ProvisioningSubsystem = { ...base, async ensureResource(...a) { calls++; return base.ensureResource(...a) } }
    const adapters = { ...allOk(), matrix: counting }

    const [r1, r2] = await Promise.all([
      attachSubsystem(u.id, 'matrix', adapters),
      attachSubsystem(u.id, 'matrix', adapters)
    ])

    expect(r1.subsystems.find((s) => s.subsystem === 'matrix')?.status).toBe('ok')
    expect(r2.subsystems.find((s) => s.subsystem === 'matrix')?.status).toBe('ok')
    expect(calls).toBe(1)

    const resource = await getResource(u.id, 'matrix')
    expect(resource?.status).toBe('ok')
    expect(resource?.external_id).toBe('!r:s')
  })

  it('T2: releaseSubsystem runs teardown before the DB detach; a throwing teardown leaves the ledger and flag unchanged', async () => {
    const u = await unit()
    await attachSubsystem(u.id, 'matrix', allOk())
    expect((await getResource(u.id, 'matrix'))?.status).toBe('ok')

    await expect(
      releaseSubsystem(u.id, 'matrix', async () => { throw new Error('matrix down') })
    ).rejects.toThrow('matrix down')

    const resource = await getResource(u.id, 'matrix')
    expect(resource?.status).toBe('ok')
    expect(resource?.external_id).toBe('!r:s')

    const rows = await getDb()<Array<{ wants_matrix_room: boolean }>>`
      SELECT wants_matrix_room FROM org_units WHERE id = ${u.id}`
    expect(rows[0]?.wants_matrix_room).toBe(true)
  })

  it('T3: after release, listDueOrgUnitIds excludes the unit and provisionOrgUnit reports matrix skipped; the adapter is never called', async () => {
    const u = await unit()
    await attachSubsystem(u.id, 'matrix', allOk())

    let calls = 0
    const base = okAdapter('matrix', '!r:s')
    const counting: ProvisioningSubsystem = { ...base, async ensureResource(...a) { calls++; return base.ensureResource(...a) } }
    await releaseSubsystem(u.id, 'matrix', async () => { /* torn down */ })

    expect(await listDueOrgUnitIds()).not.toContain(u.id)

    const report = await provisionOrgUnit(u.id, { ...allOk(), matrix: counting })
    expect(report.subsystems.find((s) => s.subsystem === 'matrix')?.status).toBe('skipped')
    expect(calls).toBe(0)
  })

  it('T4: after release, addMember/removeMember fan-out enqueues nothing for matrix; deprovisionOrgUnit does not call matrix removeResource', async () => {
    const u = await unit()
    await attachSubsystem(u.id, 'matrix', allOk())
    await releaseSubsystem(u.id, 'matrix', async () => { /* torn down */ })

    let removeCalls = 0
    const matrixSpy: ProvisioningSubsystem = {
      ...okAdapter('matrix', '!r:s'),
      async removeResource() { removeCalls++ },
      async addMember() { removeCalls += 1000 }, // any call here is a bug too
      async removeMember() { removeCalls += 1000 }
    }
    const adapters = { ...allOk(), matrix: matrixSpy }

    await addMember(u.id, 'user-1', 'elected', null, null, adapters)
    await removeMember(u.id, 'user-1', adapters)
    await deprovisionOrgUnit(u.id, adapters)

    expect(removeCalls).toBe(0)
    expect(await getResource(u.id, 'matrix')).toBeNull()
  })

  it('T5: release then attach again yields a fresh room (ensureResource sees externalId=null)', async () => {
    const u = await unit()
    await attachSubsystem(u.id, 'matrix', allOk())
    await releaseSubsystem(u.id, 'matrix', async () => { /* torn down */ })

    let seenExternalId: string | null | undefined
    const base = okAdapter('matrix', '!r2:s')
    const spying: ProvisioningSubsystem = {
      ...base,
      async ensureResource(unitArg, ctx, existingExternalId) {
        seenExternalId = existingExternalId
        return base.ensureResource(unitArg, ctx, existingExternalId)
      }
    }
    await attachSubsystem(u.id, 'matrix', { ...allOk(), matrix: spying })

    expect(seenExternalId).toBeNull()
    expect((await getResource(u.id, 'matrix'))?.external_id).toBe('!r2:s')
  })
})
