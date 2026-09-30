// Migration 055 — resolution_challenges (contestability channel, #320 Phase 3)
// + role_assignment_history.ended_reason 'recalled' (recall half).
//
// DB-backed schema pin: these tests assert the CHECK / FK / partial-unique
// contracts of migration 055 directly against the pre-migrated integration
// Postgres — no service layer exists yet (the DB constraints ARE the deliverable).
import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../db'
import { createOrgUnit } from './org-units-db'
import { createProtocol } from '../protocols/protocol-db'

/** Seed one org unit → protocol → adopted resolution; returns the resolution id. */
async function seedResolution(): Promise<string> {
  const unit = await createOrgUnit({
    name: 'Rat', description: null, parentId: null, kind: 'council',
    visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
  })
  const protocol = await createProtocol({
    committeeId: unit.id, meetingDate: '2026-07-01', title: 'Sitzung', createdBy: 'clerk',
  })
  const sql = getDb()
  const [row] = await sql`
    INSERT INTO protocol_resolutions (protocol_id, sequence_nr, text, result)
    VALUES (${protocol.id}, 1, 'Beschlusstext', 'passed')
    RETURNING id`
  return row.id as string
}

describe('resolution_challenges (migration 055)', () => {
  beforeEach(async () => {
    const sql = getDb()
    // Deleting org_units cascades protocols → protocol_resolutions →
    // resolution_challenges, and committee_roles → role_assignment_history.
    await sql`DELETE FROM protocol_attendance`
    await sql`DELETE FROM protocols`
    await sql`DELETE FROM org_unit_members`
    await sql`DELETE FROM org_units`
  })

  it('(a) rejects an unknown status via the status CHECK', async () => {
    const resolutionId = await seedResolution()
    const sql = getDb()
    await expect(
      sql`INSERT INTO resolution_challenges (resolution_id, raised_by, grounds, status)
          VALUES (${resolutionId}, 'member-1', 'Formfehler', 'bogus')`,
    ).rejects.toThrow(/resolution_challenges_status_check/)
  })

  it('(b) rejects grounds over the bounded length via the grounds CHECK', async () => {
    const resolutionId = await seedResolution()
    const sql = getDb()
    const tooLong = 'x'.repeat(4001)
    await expect(
      sql`INSERT INTO resolution_challenges (resolution_id, raised_by, grounds)
          VALUES (${resolutionId}, 'member-1', ${tooLong})`,
    ).rejects.toThrow(/resolution_challenges_grounds_check/)
  })

  it('(c) DELETE of the parent protocol_resolutions row cascades the challenge away', async () => {
    const resolutionId = await seedResolution()
    const sql = getDb()
    await sql`INSERT INTO resolution_challenges (resolution_id, raised_by, grounds)
              VALUES (${resolutionId}, 'member-1', 'Formfehler')`
    await sql`DELETE FROM protocol_resolutions WHERE id = ${resolutionId}`
    const rows = await sql`SELECT id FROM resolution_challenges WHERE resolution_id = ${resolutionId}`
    expect(rows).toHaveLength(0)
  })

  it("(d) role_assignment_history accepts ended_reason 'recalled'", async () => {
    const unit = await createOrgUnit({
      name: 'Rat', description: null, parentId: null, kind: 'council',
      visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
    })
    const sql = getDb()
    const [role] = await sql`
      INSERT INTO committee_roles (org_unit_id, name) VALUES (${unit.id}, 'Sprecher') RETURNING id`
    await sql`INSERT INTO role_assignment_history (role_id, user_keycloak_id, start_date, end_date, ended_reason)
              VALUES (${role.id}, 'user-1', '2026-01-01', '2026-07-01', 'recalled')`
    const rows = await sql`SELECT ended_reason FROM role_assignment_history WHERE role_id = ${role.id}`
    expect(rows).toHaveLength(1)
    expect(rows[0].ended_reason).toBe('recalled')
  })

  it('(e) rejects a second OPEN challenge for the same (resolution_id, raised_by) on the partial-unique backstop', async () => {
    const resolutionId = await seedResolution()
    const sql = getDb()
    await sql`INSERT INTO resolution_challenges (resolution_id, raised_by, grounds)
              VALUES (${resolutionId}, 'member-1', 'Formfehler')`
    await expect(
      sql`INSERT INTO resolution_challenges (resolution_id, raised_by, grounds)
          VALUES (${resolutionId}, 'member-1', 'Nochmal Formfehler')`,
    ).rejects.toThrow(/resolution_challenges_one_open_per_challenger/)
  })
})
