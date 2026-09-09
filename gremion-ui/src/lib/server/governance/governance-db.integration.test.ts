import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../db'
import { createOrgUnit } from './org-units-db'
import { createRole, listRoles } from './governance-db'

describe('governance-db', () => {
  beforeEach(async () => {
    const sql = getDb()
    await sql`TRUNCATE org_units RESTART IDENTITY CASCADE`
    await sql`DELETE FROM committee_roles`
    await sql`DELETE FROM org_unit_members`
    await sql`DELETE FROM committee_elections`
    await sql`DELETE FROM org_units`
  })

  describe('createRole', () => {
    it('inserts a role linked to an org-unit and returns org_unit_id', async () => {
      const orgUnit = await createOrgUnit({
        name: 'Vorstand', description: null, parentId: null, kind: 'committee',
        visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false
      })
      const role = await createRole({
        orgUnitId: orgUnit.id,
        name: 'Chairperson',
        electionMethod: 'helios',
        isElected: true,
        gracePeriodDays: 30
      })
      expect(role.org_unit_id).toBe(orgUnit.id)
      expect(role.name).toBe('Chairperson')
      expect(role.election_method).toBe('helios')
      expect(role.is_elected).toBe(true)
      expect(role.grace_period_days).toBe(30)
      expect(typeof role.id).toBe('string')
    })
  })

  describe('listRoles', () => {
    it('returns roles created for the given org-unit', async () => {
      const orgUnit = await createOrgUnit({
        name: 'IT-Referat', description: null, parentId: null, kind: 'committee',
        visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false
      })
      await createRole({
        orgUnitId: orgUnit.id,
        name: 'Treasurer',
        electionMethod: 'manual',
        isElected: false,
        gracePeriodDays: 14
      })
      await createRole({
        orgUnitId: orgUnit.id,
        name: 'Secretary',
        electionMethod: 'poll',
        isElected: true,
        gracePeriodDays: 7
      })
      const roles = await listRoles(orgUnit.id)
      expect(roles).toHaveLength(2)
      // listRoles orders by name
      expect(roles[0]!.name).toBe('Secretary')
      expect(roles[1]!.name).toBe('Treasurer')
      roles.forEach((r) => expect(r.org_unit_id).toBe(orgUnit.id))
    })

    it('returns an empty array for an org-unit with no roles', async () => {
      const orgUnit = await createOrgUnit({
        name: 'Kulturreferat', description: null, parentId: null, kind: 'committee',
        visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false
      })
      const roles = await listRoles(orgUnit.id)
      expect(roles).toEqual([])
    })
  })
})
