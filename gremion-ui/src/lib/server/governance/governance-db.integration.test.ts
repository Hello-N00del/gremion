import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../db'
import { createOrgUnit } from './org-units-db'
import {
  createRole, listRoles, createAssignment, getActiveAssignment,
  archiveAssignment, listActiveRoleNamesForUser, listAllRoleNames,
} from './governance-db'

describe('governance-db', () => {
  beforeEach(async () => {
    const sql = getDb()
    await sql`TRUNCATE org_units RESTART IDENTITY CASCADE`
    await sql`DELETE FROM role_assignment_history`
    await sql`DELETE FROM role_assignments`
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

  // Audit 420 (item 1): backs the flat-group grant RECONCILIATION in
  // role-group-reconcile.ts — an outgoing holder's ref-finanzen* grant is only
  // revoked when NONE of their remaining active roles re-grants it, and
  // listActiveRoleNamesForUser is what tells the reconciler what they still hold.
  describe('listActiveRoleNamesForUser', () => {
    const assign = (roleId: string, userId: string) =>
      createAssignment({
        roleId, userKeycloakId: userId,
        startDate: new Date('2026-01-01'), endDate: new Date('2027-01-01'),
        assignedByKeycloakId: 'admin', heliosElectionId: null,
      })

    it('returns every committee role a user still actively holds, realm-wide', async () => {
      const board = await createOrgUnit({
        name: 'Vorstand', description: null, parentId: null, kind: 'committee',
        visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
      })
      const ref = await createOrgUnit({
        name: 'Referat Finanzen', description: null, parentId: null, kind: 'committee',
        visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
      })
      const fv = await createRole({ orgUnitId: board.id, name: 'Finanzvorstand', electionMethod: 'manual', isElected: false, gracePeriodDays: 0 })
      const rf = await createRole({ orgUnitId: ref.id, name: 'Referent·in Finanzen', electionMethod: 'manual', isElected: false, gracePeriodDays: 0 })
      // Same user holds BOTH roles (across two org units).
      await assign(fv.id, 'user-multi')
      await assign(rf.id, 'user-multi')

      expect([...(await listActiveRoleNamesForUser('user-multi'))].sort())
        .toEqual(['Finanzvorstand', 'Referent·in Finanzen'])
      // An unrelated user holds nothing.
      expect(await listActiveRoleNamesForUser('nobody')).toEqual([])
    })

    it('excludes a role once its assignment is archived (vacated)', async () => {
      const board = await createOrgUnit({
        name: 'Vorstand', description: null, parentId: null, kind: 'committee',
        visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
      })
      const fv = await createRole({ orgUnitId: board.id, name: 'Finanzvorstand', electionMethod: 'manual', isElected: false, gracePeriodDays: 0 })
      await assign(fv.id, 'user-x')
      expect(await listActiveRoleNamesForUser('user-x')).toEqual(['Finanzvorstand'])

      const active = await getActiveAssignment(fv.id)
      await archiveAssignment(active!, 'removed')
      // Vacated → no longer counted as held.
      expect(await listActiveRoleNamesForUser('user-x')).toEqual([])
    })
  })

  // Audit 420 (item 1): listAllRoleNames feeds the reconcile UNIVERSE (every
  // group any DEFINED role could grant) — deliberately DISTINCT role names
  // realm-wide, not scoped to one org unit, and independent of who (if anyone)
  // currently holds the role.
  describe('listAllRoleNames', () => {
    it('returns every distinct role name across all org units, deduplicated', async () => {
      const board = await createOrgUnit({
        name: 'Vorstand', description: null, parentId: null, kind: 'committee',
        visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
      })
      const ref = await createOrgUnit({
        name: 'Referat Finanzen', description: null, parentId: null, kind: 'committee',
        visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
      })
      await createRole({ orgUnitId: board.id, name: 'Finanzvorstand', electionMethod: 'manual', isElected: false, gracePeriodDays: 0 })
      await createRole({ orgUnitId: ref.id, name: 'Referent·in Finanzen', electionMethod: 'manual', isElected: false, gracePeriodDays: 0 })
      // Same role name reused in a second org unit — must be deduplicated.
      await createRole({ orgUnitId: ref.id, name: 'Finanzvorstand', electionMethod: 'manual', isElected: false, gracePeriodDays: 0 })

      expect([...(await listAllRoleNames())].sort()).toEqual(
        ['Finanzvorstand', 'Referent·in Finanzen'].sort(),
      )
    })

    it('returns an empty array when no roles are defined', async () => {
      expect(await listAllRoleNames()).toEqual([])
    })
  })
})
