import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../db'
import { createOrgUnit, addOrgUnitMember } from './org-units-db'
import { createProtocol } from '../protocols/protocol-db'
import { decideResolution, NotQuorateError } from './resolution-decision'

async function seedQuorateProtocol() {
  const unit = await createOrgUnit({
    name: 'Rat', description: null, parentId: null, kind: 'council',
    visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
  })
  for (let i = 0; i < 3; i++) {
    await addOrgUnitMember({
      orgUnitId: unit.id, userKeycloakId: `voter-${i}`, membershipType: 'elected',
      termStart: null, termEnd: null, voting: true,
    })
  }
  const protocol = await createProtocol({
    committeeId: unit.id, meetingDate: '2026-06-21', title: 'Sitzung', createdBy: 'voter-0',
  })
  const sql = getDb()
  await sql`INSERT INTO protocol_attendance (protocol_id, user_keycloak_id, status)
            VALUES (${protocol.id}, 'voter-0', 'present'), (${protocol.id}, 'voter-1', 'present')`
  return protocol
}

describe('decideResolution', () => {
  beforeEach(async () => {
    const sql = getDb()
    await sql`DELETE FROM protocol_attendance`
    await sql`DELETE FROM protocols`
    await sql`DELETE FROM org_unit_members`
    await sql`DELETE FROM org_units`
  })

  it('computes passed when quorate and the majority rule is met', async () => {
    const protocol = await seedQuorateProtocol()
    const d = await decideResolution({
      protocolId: protocol.id, votesYes: 2, votesNo: 0, votesAbstain: 0, requiredMajority: 'simple',
    })
    expect(d.result).toBe('passed')
    expect(d.quorum?.quorate).toBe(true)
  })

  it('computes rejected when quorate but the majority rule fails', async () => {
    const protocol = await seedQuorateProtocol()
    const d = await decideResolution({
      protocolId: protocol.id, votesYes: 1, votesNo: 2, votesAbstain: 0, requiredMajority: 'simple',
    })
    expect(d.result).toBe('rejected')
  })

  it('throws NotQuorateError when the meeting is not quorate', async () => {
    const unit = await createOrgUnit({
      name: 'Rat', description: null, parentId: null, kind: 'council',
      visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
    })
    for (let i = 0; i < 3; i++) {
      await addOrgUnitMember({
        orgUnitId: unit.id, userKeycloakId: `voter-${i}`, membershipType: 'elected',
        termStart: null, termEnd: null, voting: true,
      })
    }
    const protocol = await createProtocol({
      committeeId: unit.id, meetingDate: '2026-06-21', title: 'Sitzung', createdBy: 'voter-0',
    })
    const sql = getDb()
    await sql`INSERT INTO protocol_attendance (protocol_id, user_keycloak_id, status)
              VALUES (${protocol.id}, 'voter-0', 'present')`

    await expect(
      decideResolution({ protocolId: protocol.id, votesYes: 1, votesNo: 0, votesAbstain: 0, requiredMajority: 'simple' }),
    ).rejects.toBeInstanceOf(NotQuorateError)
  })

  it('withdrawn bypasses quorum and majority', async () => {
    const unit = await createOrgUnit({
      name: 'Rat', description: null, parentId: null, kind: 'council',
      visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
    })
    const protocol = await createProtocol({
      committeeId: unit.id, meetingDate: '2026-06-21', title: 'Sitzung', createdBy: 'x',
    })
    const d = await decideResolution({
      protocolId: protocol.id, votesYes: 0, votesNo: 0, votesAbstain: 0, requiredMajority: 'simple', withdrawn: true,
    })
    expect(d.result).toBe('withdrawn')
    expect(d.quorum).toBeNull()
  })

  it('enforceQuorum:false computes the result from rule+tallies even when not quorate (draft path)', async () => {
    const unit = await createOrgUnit({
      name: 'Rat', description: null, parentId: null, kind: 'council',
      visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
    })
    for (let i = 0; i < 3; i++) {
      await addOrgUnitMember({
        orgUnitId: unit.id, userKeycloakId: `voter-${i}`, membershipType: 'elected',
        termStart: null, termEnd: null, voting: true,
      })
    }
    const protocol = await createProtocol({
      committeeId: unit.id, meetingDate: '2026-06-21', title: 'Sitzung', createdBy: 'voter-0',
    })
    // only 1 of 3 present → NOT quorate; the draft write path must not throw.
    const sql = getDb()
    await sql`INSERT INTO protocol_attendance (protocol_id, user_keycloak_id, status)
              VALUES (${protocol.id}, 'voter-0', 'present')`

    const d = await decideResolution({
      protocolId: protocol.id, votesYes: 2, votesNo: 0, votesAbstain: 0, requiredMajority: 'simple',
      enforceQuorum: false,
    })
    expect(d.result).toBe('passed') // rule+tallies decide; quorum not enforced on the draft path
    expect(d.quorum?.quorate).toBe(false) // the (non-)quorum context is still reported
  })
})
