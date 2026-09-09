import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../db'
import { createOrgUnit, addOrgUnitMember } from './org-units-db'
import { createProtocol } from '../protocols/protocol-db'
import { getQuorumContext } from './quorum'

async function seedBodyWithVoters(votingCount: number) {
  const unit = await createOrgUnit({
    name: 'Rat', description: null, parentId: null, kind: 'council',
    visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
  })
  for (let i = 0; i < votingCount; i++) {
    await addOrgUnitMember({
      orgUnitId: unit.id, userKeycloakId: `voter-${i}`, membershipType: 'elected',
      termStart: null, termEnd: null, voting: true,
    })
  }
  return unit
}

describe('getQuorumContext', () => {
  beforeEach(async () => {
    const sql = getDb()
    await sql`DELETE FROM protocol_attendance`
    await sql`DELETE FROM protocols`
    await sql`DELETE FROM org_unit_members`
    await sql`DELETE FROM org_units`
  })

  it('is quorate when a strict majority of eligible voters are present', async () => {
    const unit = await seedBodyWithVoters(3)
    const protocol = await createProtocol({
      committeeId: unit.id, meetingDate: '2026-06-21', title: 'Sitzung', createdBy: 'voter-0',
    })
    const sql = getDb()
    await sql`INSERT INTO protocol_attendance (protocol_id, user_keycloak_id, status)
              VALUES (${protocol.id}, 'voter-0', 'present'), (${protocol.id}, 'voter-1', 'present')`

    const ctx = await getQuorumContext(protocol.id)
    expect(ctx.eligibleVotingCount).toBe(3)
    expect(ctx.presentVotingCount).toBe(2)
    expect(ctx.quorate).toBe(true)
  })

  it('is NOT quorate when only a minority are present', async () => {
    const unit = await seedBodyWithVoters(3)
    const protocol = await createProtocol({
      committeeId: unit.id, meetingDate: '2026-06-21', title: 'Sitzung', createdBy: 'voter-0',
    })
    const sql = getDb()
    await sql`INSERT INTO protocol_attendance (protocol_id, user_keycloak_id, status)
              VALUES (${protocol.id}, 'voter-0', 'present')`

    const ctx = await getQuorumContext(protocol.id)
    expect(ctx.presentVotingCount).toBe(1)
    expect(ctx.quorate).toBe(false)
  })

  it('non-voting members and absent/excused do not count toward presence', async () => {
    const unit = await seedBodyWithVoters(2)
    await addOrgUnitMember({
      orgUnitId: unit.id, userKeycloakId: 'observer', membershipType: 'unelected',
      termStart: null, termEnd: null, voting: false,
    })
    const protocol = await createProtocol({
      committeeId: unit.id, meetingDate: '2026-06-21', title: 'Sitzung', createdBy: 'voter-0',
    })
    const sql = getDb()
    await sql`INSERT INTO protocol_attendance (protocol_id, user_keycloak_id, status)
              VALUES (${protocol.id}, 'voter-0', 'present'),
                     (${protocol.id}, 'observer', 'present'),
                     (${protocol.id}, 'voter-1', 'excused')`

    const ctx = await getQuorumContext(protocol.id)
    expect(ctx.eligibleVotingCount).toBe(2) // observer is non-voting
    expect(ctx.presentVotingCount).toBe(1)  // only voter-0
    expect(ctx.quorate).toBe(false)
  })
})
