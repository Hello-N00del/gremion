// F1-FIX-04 (H18): the first-login auto-join candidates come from the real
// provisioning ledger x org_unit_members. This pins the query against the real
// schema: only the Matrix rooms of the caller's own units, never another
// unit's room, never a subsystem other than matrix, never a row without a room.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getDb } from '../db'
import { createOrgUnit, addOrgUnitMember } from '../governance/org-units-db'
import { listOwnUnitRoomIds } from './auto-join'

describe('listOwnUnitRoomIds against the real schema', () => {
  // TASK-205b: leave the shared integration database as found (one database, one file at a time).
  afterAll(async () => {
    await getDb()`TRUNCATE org_units RESTART IDENTITY CASCADE`
  })

  beforeEach(async () => {
    const sql = getDb()
    await sql`TRUNCATE org_units RESTART IDENTITY CASCADE`
    const mine = await createOrgUnit({
      name: 'Mein Gremium', description: null, parentId: null, kind: 'committee',
      visibility: 'committee_only', wantsMatrixRoom: true, wantsNextcloudFolder: true,
    })
    const other = await createOrgUnit({
      name: 'Fremdes Gremium', description: null, parentId: null, kind: 'committee',
      visibility: 'committee_only', wantsMatrixRoom: true, wantsNextcloudFolder: false,
    })
    const pending = await createOrgUnit({
      name: 'Noch ohne Raum', description: null, parentId: null, kind: 'committee',
      visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: false,
    })
    for (const unitId of [mine.id, pending.id]) {
      await addOrgUnitMember({
        orgUnitId: unitId, userKeycloakId: 'caller', membershipType: 'elected', termStart: null, termEnd: null,
      })
    }
    await sql`
      INSERT INTO provisioning_resources (org_unit_id, subsystem, external_id, status) VALUES
        (${mine.id}, 'matrix', '!mine:matrix.test', 'ok'),
        (${mine.id}, 'nextcloud', '/Gremien/Mein', 'ok'),
        (${other.id}, 'matrix', '!other:matrix.test', 'ok'),
        (${pending.id}, 'matrix', NULL, 'pending')`
  })

  it('returns only the Matrix room of the caller own unit', async () => {
    expect(await listOwnUnitRoomIds('caller')).toEqual(['!mine:matrix.test'])
  })

  it('returns nothing for a user of no unit', async () => {
    expect(await listOwnUnitRoomIds('stranger')).toEqual([])
  })
})
