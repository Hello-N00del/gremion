import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../db'
import {
  createOrgUnit, getOrgUnit, listOrgUnits, getChildOrgUnits,
  updateOrgUnit, deleteOrgUnit,
  addOrgUnitMember, listOrgUnitMembers, removeOrgUnitMember,
  isMemberOf, getOrgUnitIdsForUser, buildOrgTree
} from './org-units-db'

describe('org-units-db', () => {
  beforeEach(async () => {
    const sql = getDb()
    await sql`TRUNCATE org_units RESTART IDENTITY CASCADE`
    await sql`DELETE FROM org_unit_members`
    await sql`DELETE FROM committee_elections`
    await sql`DELETE FROM org_units`
  })

  it('creates and reads a top-level council', async () => {
    const u = await createOrgUnit({
      name: 'StuRa', description: null, parentId: null, kind: 'council',
      visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true, childTerm: null
    })
    expect(u.kind).toBe('council')
    const fetched = await getOrgUnit(u.id)
    expect(fetched?.name).toBe('StuRa')
  })

  it('nests children and lists them by parent', async () => {
    const parent = await createOrgUnit({
      name: 'StuRa', description: null, parentId: null, kind: 'council',
      visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true, childTerm: null
    })
    const child = await createOrgUnit({
      name: 'Vorstand', description: null, parentId: parent.id, kind: 'committee',
      visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true, childTerm: null
    })
    const children = await getChildOrgUnits(parent.id)
    expect(children.map((c) => c.id)).toEqual([child.id])
  })

  it('updateOrgUnit clears the description when null is passed, leaves it when omitted', async () => {
    const u = await createOrgUnit({
      name: 'Ref', description: 'has one', parentId: null, kind: 'committee',
      visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true, childTerm: null
    })
    const cleared = await updateOrgUnit(u.id, { description: null })
    expect(cleared?.description).toBeNull()
    const renamed = await updateOrgUnit(u.id, { name: 'Referat' })
    expect(renamed?.name).toBe('Referat')
    expect(renamed?.description).toBeNull() // unchanged — not provided
  })

  it('adds, lists and removes members with a membership type', async () => {
    const u = await createOrgUnit({
      name: 'IT-Team', description: null, parentId: null, kind: 'group',
      visibility: 'committee_only', wantsMatrixRoom: true, wantsNextcloudFolder: false, childTerm: null
    })
    await addOrgUnitMember({ orgUnitId: u.id, userKeycloakId: 'user-1', membershipType: 'employee', termStart: null, termEnd: null })
    expect(await isMemberOf(u.id, 'user-1')).toBe(true)
    expect((await listOrgUnitMembers(u.id))[0].membership_type).toBe('employee')
    expect(await getOrgUnitIdsForUser('user-1')).toEqual([u.id])
    await removeOrgUnitMember(u.id, 'user-1')
    expect(await isMemberOf(u.id, 'user-1')).toBe(false)
  })

  it('upsert preserves a stored voting=false when re-added without voting (§3.5(d))', async () => {
    const u = await createOrgUnit({
      name: 'Ausschuss', description: null, parentId: null, kind: 'group',
      visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false, childTerm: null
    })
    await addOrgUnitMember({ orgUnitId: u.id, userKeycloakId: 'user-skb', membershipType: 'unelected', termStart: null, termEnd: null, voting: false })
    // Runtime paths (orchestrator addMember, members POST) omit `voting` —
    // the conflict branch must keep the stored false, not reset to true.
    await addOrgUnitMember({ orgUnitId: u.id, userKeycloakId: 'user-skb', membershipType: 'elected', termStart: null, termEnd: null })
    const after = (await listOrgUnitMembers(u.id))[0]!
    expect(after.membership_type).toBe('elected') // other fields still update
    expect(after.voting).toBe(false)
    // An explicit voting still overwrites on conflict.
    await addOrgUnitMember({ orgUnitId: u.id, userKeycloakId: 'user-skb', membershipType: 'elected', termStart: null, termEnd: null, voting: true })
    expect((await listOrgUnitMembers(u.id))[0]!.voting).toBe(true)
  })

  it('createOrgUnit accepts a caller-supplied tx and rolls back cleanly', async () => {
    // The tx? overload must route the INSERT through the caller's tx handle
    // — throwing from the begin() callback must leave org_units empty.
    let createdId: string | undefined
    await getDb()
      .begin(async (tx) => {
        const inside = await createOrgUnit(tx, {
          name: 'TxScratch', description: null, parentId: null, kind: 'group',
          visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false, childTerm: null
        })
        createdId = inside.id
        expect(await getOrgUnit(tx, inside.id)).not.toBeNull()
        throw new Error('rollback-marker')
      })
      .catch((e) => {
        if (e.message !== 'rollback-marker') throw e
      })
    expect(createdId).toBeDefined()
    // After rollback the row must not exist outside the tx (global pool).
    expect(await getOrgUnit(createdId!)).toBeNull()
  })

  it('updateOrgUnit + deleteOrgUnit accept a caller-supplied tx', async () => {
    // Commit boundary: writes inside begin() must be visible afterwards;
    // the overload is exercised on update + delete in one pass.
    const u = await createOrgUnit({
      name: 'TxCommit', description: null, parentId: null, kind: 'group',
      visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false, childTerm: null
    })
    await getDb().begin(async (tx) => {
      const renamed = await updateOrgUnit(tx, u.id, { name: 'TxCommit-renamed' })
      expect(renamed?.name).toBe('TxCommit-renamed')
    })
    expect((await getOrgUnit(u.id))?.name).toBe('TxCommit-renamed')

    await getDb().begin(async (tx) => {
      await deleteOrgUnit(tx, u.id)
    })
    expect(await getOrgUnit(u.id)).toBeNull()
  })

  // ── Task 4: tx-overloads for addOrgUnitMember / removeOrgUnitMember ──────

  async function seedUnit(): Promise<string> {
    const u = await createOrgUnit({
      name: 'TxMemberUnit', description: null, parentId: null, kind: 'group',
      visibility: 'committee_only', wantsMatrixRoom: false, wantsNextcloudFolder: false, childTerm: null
    })
    return u.id
  }

  it('removeOrgUnitMember honors a tx (rolls back with it)', async () => {
    const unitId = await seedUnit()
    await addOrgUnitMember({ orgUnitId: unitId, userKeycloakId: 'u-tx', membershipType: 'unelected', termStart: null, termEnd: null })
    // Delete inside a tx that rolls back — member must still exist
    await getDb().begin(async (tx) => {
      await removeOrgUnitMember(tx, unitId, 'u-tx')
      throw new Error('rollback')
    }).catch(() => undefined)
    expect(await isMemberOf(unitId, 'u-tx')).toBe(true)
    // Delete inside a tx that commits — member must be gone
    await getDb().begin(async (tx) => { await removeOrgUnitMember(tx, unitId, 'u-tx') })
    expect(await isMemberOf(unitId, 'u-tx')).toBe(false)
  })

  it('addOrgUnitMember honors a tx (rolls back with it)', async () => {
    const unitId = await seedUnit()
    // Insert inside a tx that rolls back — member must NOT exist afterwards
    await getDb().begin(async (tx) => {
      await addOrgUnitMember(tx, { orgUnitId: unitId, userKeycloakId: 'u-tx-add', membershipType: 'elected', termStart: null, termEnd: null })
      throw new Error('rollback')
    }).catch(() => undefined)
    expect(await isMemberOf(unitId, 'u-tx-add')).toBe(false)
    // Insert inside a tx that commits — member must exist
    await getDb().begin(async (tx) => {
      await addOrgUnitMember(tx, { orgUnitId: unitId, userKeycloakId: 'u-tx-add', membershipType: 'elected', termStart: null, termEnd: null })
    })
    expect(await isMemberOf(unitId, 'u-tx-add')).toBe(true)
  })
})
