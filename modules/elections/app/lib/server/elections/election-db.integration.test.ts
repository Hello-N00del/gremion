import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getDb } from '../db'
import { createOrgUnit, addOrgUnitMember } from '../governance/org-units-db'
import { ElectionDb } from './election-db'

// Valid UUID constants for test data (created_by is a UUID column)
const USER_UUID = '00000000-0000-0000-0000-000000000001'
const ADMIN_UUID = '00000000-0000-0000-0000-000000000002'

describe('ElectionDb', () => {
  // TASK-205b: leave the shared integration database as found. The suite runs one file at a time against ONE
  // database, and a committee_elections row left behind makes every later file's `DELETE FROM org_units`
  // violate committee_elections_committee_id_fkey (the governance suites run after this one).
  afterAll(async () => {
    const sql = getDb()
    await sql`DELETE FROM committee_elections`
    await sql`DELETE FROM org_unit_members`
    await sql`DELETE FROM org_units`
  })

  beforeEach(async () => {
    const sql = getDb()
    await sql`TRUNCATE org_units RESTART IDENTITY CASCADE`
    await sql`DELETE FROM committee_elections`
    await sql`DELETE FROM org_unit_members`
    await sql`DELETE FROM org_units`
  })

  it('insert writes a new committee_elections row and returns it', async () => {
    const unit = await createOrgUnit({
      name: 'Wahlgremium Insert', description: null, parentId: null, kind: 'committee',
      visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false
    })
    const result = await ElectionDb.insert({
      heliosUuid: 'helios-abc',
      orgUnitId: unit.id,
      createdBy: USER_UUID,
      calendarLinked: false,
    })
    expect(result.helios_uuid).toBe('helios-abc')
    expect(result.org_unit_id).toBe(unit.id)
  })

  it('findByOrgUnitIds returns rows matching org unit ids', async () => {
    const unit = await createOrgUnit({
      name: 'Gremium A', description: null, parentId: null, kind: 'committee',
      visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false
    })
    await ElectionDb.insert({
      heliosUuid: 'h1',
      orgUnitId: unit.id,
      createdBy: USER_UUID,
      calendarLinked: true,
    })

    const results = await ElectionDb.findByOrgUnitIds([unit.id])
    expect(results).toHaveLength(1)
    expect(results[0].helios_uuid).toBe('h1')
  })

  it('findByOrgUnitIds returns empty array when input is empty (no DB call)', async () => {
    const results = await ElectionDb.findByOrgUnitIds([])
    expect(results).toEqual([])
  })

  it('findAll returns all non-archived rows', async () => {
    const unit = await createOrgUnit({
      name: 'Gremium Findall', description: null, parentId: null, kind: 'committee',
      visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false
    })
    await ElectionDb.insert({
      heliosUuid: 'helios-findall',
      orgUnitId: unit.id,
      createdBy: USER_UUID,
      calendarLinked: false,
    })
    const results = await ElectionDb.findAll()
    expect(results.length).toBeGreaterThanOrEqual(1)
  })

  it('findByHeliosUuid returns a single row or null', async () => {
    const unit = await createOrgUnit({
      name: 'Gremium ByUuid', description: null, parentId: null, kind: 'committee',
      visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false
    })
    await ElectionDb.insert({
      heliosUuid: 'h-byuuid',
      orgUnitId: unit.id,
      createdBy: USER_UUID,
      calendarLinked: false,
    })
    const result = await ElectionDb.findByHeliosUuid('h-byuuid')
    expect(result?.helios_uuid).toBe('h-byuuid')
  })

  it('findByHeliosUuid returns null when no row found', async () => {
    const result = await ElectionDb.findByHeliosUuid('missing')
    expect(result).toBeNull()
  })

  it('markCalendarLinked updates calendar_linked to true', async () => {
    const unit = await createOrgUnit({
      name: 'Gremium CalLink', description: null, parentId: null, kind: 'committee',
      visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false
    })
    await ElectionDb.insert({
      heliosUuid: 'helios-callink',
      orgUnitId: unit.id,
      createdBy: USER_UUID,
      calendarLinked: false,
    })
    await ElectionDb.markCalendarLinked('helios-callink')
    const row = await ElectionDb.findByHeliosUuid('helios-callink')
    expect(row?.calendar_linked).toBe(true)
  })

  it('findVisibleToUser returns elections of org-units the user is a member of', async () => {
    const unit = await createOrgUnit({
      name: 'Wahlgremium', description: null, parentId: null, kind: 'committee',
      visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false
    })
    await addOrgUnitMember({
      orgUnitId: unit.id, userKeycloakId: 'user-1',
      membershipType: 'elected', termStart: null, termEnd: null
    })
    await ElectionDb.insert({
      heliosUuid: 'h-1', orgUnitId: unit.id, createdBy: ADMIN_UUID, calendarLinked: false
    })
    expect((await ElectionDb.findVisibleToUser('user-1')).map((e) => e.helios_uuid)).toEqual(['h-1'])
    expect(await ElectionDb.findVisibleToUser('stranger')).toEqual([])
  })
})
