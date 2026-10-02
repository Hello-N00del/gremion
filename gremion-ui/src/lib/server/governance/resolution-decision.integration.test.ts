import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../db'
import { createOrgUnit, addOrgUnitMember } from './org-units-db'
import { createProtocol } from '../protocols/protocol-db'
import { decideResolution, NotQuorateError, InvalidDeclaredResultError } from './resolution-decision'
import { InvalidDecisionRuleParamsError } from './decision-rule'

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

// A body of `voters` voting members, `present` of them attending. Used to pin
// the support_threshold rule against a KNOWN eligible count (its threshold is a
// fraction of ELIGIBLE, not of votes cast).
async function seedProtocolWithVoters(voters: number, present: number) {
  const unit = await createOrgUnit({
    name: 'Rat', description: null, parentId: null, kind: 'council',
    visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
  })
  for (let i = 0; i < voters; i++) {
    await addOrgUnitMember({
      orgUnitId: unit.id, userKeycloakId: `voter-${i}`, membershipType: 'elected',
      termStart: null, termEnd: null, voting: true,
    })
  }
  const protocol = await createProtocol({
    committeeId: unit.id, meetingDate: '2026-06-21', title: 'Sitzung', createdBy: 'voter-0',
  })
  const sql = getDb()
  for (let i = 0; i < present; i++) {
    await sql`INSERT INTO protocol_attendance (protocol_id, user_keycloak_id, status)
              VALUES (${protocol.id}, ${`voter-${i}`}, 'present')`
  }
  return protocol
}

// Same body shape as seedQuorateProtocol (3 voting members) but only 1 of 3
// present → NOT quorate.
async function seedNonQuorateProtocol() {
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

  describe('acclamation adoption mode', () => {
    it('acclamation + declaredResult passed returns passed without consulting tallies (null votes)', async () => {
      const protocol = await seedQuorateProtocol()
      const d = await decideResolution({
        protocolId: protocol.id, adoptionMode: 'acclamation', declaredResult: 'passed',
        votesYes: null, votesNo: null, votesAbstain: null,
      })
      expect(d.result).toBe('passed')
      expect(d.quorum?.quorate).toBe(true)
    })

    it('acclamation + declaredResult rejected records rejected', async () => {
      const protocol = await seedQuorateProtocol()
      const d = await decideResolution({
        protocolId: protocol.id, adoptionMode: 'acclamation', declaredResult: 'rejected',
        votesYes: null, votesNo: null, votesAbstain: null,
      })
      expect(d.result).toBe('rejected')
    })

    it('acclamation with declaredResult missing throws a typed validation error', async () => {
      const protocol = await seedQuorateProtocol()
      await expect(
        decideResolution({
          protocolId: protocol.id, adoptionMode: 'acclamation',
          votesYes: null, votesNo: null, votesAbstain: null,
        }),
      ).rejects.toBeInstanceOf(InvalidDeclaredResultError)
    })

    it("acclamation with declaredResult 'withdrawn' throws a typed validation error", async () => {
      const protocol = await seedQuorateProtocol()
      await expect(
        decideResolution({
          protocolId: protocol.id, adoptionMode: 'acclamation', declaredResult: 'withdrawn',
          votesYes: null, votesNo: null, votesAbstain: null,
        }),
      ).rejects.toBeInstanceOf(InvalidDeclaredResultError)
    })

    it('acclamation with arbitrary declaredResult text throws a typed validation error', async () => {
      const protocol = await seedQuorateProtocol()
      await expect(
        decideResolution({
          protocolId: protocol.id, adoptionMode: 'acclamation', declaredResult: 'einstimmig angenommen',
          votesYes: null, votesNo: null, votesAbstain: null,
        }),
      ).rejects.toBeInstanceOf(InvalidDeclaredResultError)
    })

    it('acclamation on a non-quorate protocol throws NotQuorateError under default enforceQuorum (INV-5)', async () => {
      const protocol = await seedNonQuorateProtocol()
      await expect(
        decideResolution({
          protocolId: protocol.id, adoptionMode: 'acclamation', declaredResult: 'passed',
          votesYes: null, votesNo: null, votesAbstain: null,
        }),
      ).rejects.toBeInstanceOf(NotQuorateError)
    })

    it('acclamation on a non-quorate protocol with enforceQuorum:false does not throw (draft path)', async () => {
      const protocol = await seedNonQuorateProtocol()
      const d = await decideResolution({
        protocolId: protocol.id, adoptionMode: 'acclamation', declaredResult: 'passed',
        votesYes: null, votesNo: null, votesAbstain: null,
        enforceQuorum: false,
      })
      expect(d.result).toBe('passed')
      expect(d.quorum?.quorate).toBe(false)
    })
  })

  it('tally mode support_threshold evaluates yes >= ceil(fraction × ELIGIBLE) — fraction of eligible, not of cast', async () => {
    // eligible = 10 voting members (6 present → quorate); fraction 0.25 →
    // threshold = ceil(0.25 × 10) = ceil(2.5) = 3. This delegates to the
    // canonical decision-rule registry (single source of truth), which pins the
    // ceil boundary against the ELIGIBLE count.
    const protocol = await seedProtocolWithVoters(10, 6)

    // yes = 3 lands exactly on the ceil boundary → passed. votesNo is irrelevant
    // to a support quorum (Nein never counts against supporters).
    const atThreshold = await decideResolution({
      protocolId: protocol.id, votesYes: 3, votesNo: 0, votesAbstain: 0,
      requiredMajority: 'support_threshold', params: { fraction: 0.25 },
    })
    expect(atThreshold.result).toBe('passed')

    // yes = 2 is one below the ceil boundary → rejected. Under the REMOVED
    // fraction-of-cast rule this would have PASSED (2 ≥ 0.25 × (2+0) = 0.5), so
    // this case proves the eligible-basis semantics are now in force.
    const belowThreshold = await decideResolution({
      protocolId: protocol.id, votesYes: 2, votesNo: 0, votesAbstain: 0,
      requiredMajority: 'support_threshold', params: { fraction: 0.25 },
    })
    expect(belowThreshold.result).toBe('rejected')
  })

  it('tally mode support_threshold fails CLOSED when the declared fraction is missing', async () => {
    // No params.fraction → the canonical registry throws (never defaults to a
    // simple majority). Delegation surfaces the registry's typed error verbatim.
    const protocol = await seedProtocolWithVoters(10, 6)
    await expect(
      decideResolution({
        protocolId: protocol.id, votesYes: 5, votesNo: 0, votesAbstain: 0,
        requiredMajority: 'support_threshold',
      }),
    ).rejects.toBeInstanceOf(InvalidDecisionRuleParamsError)
  })
})
