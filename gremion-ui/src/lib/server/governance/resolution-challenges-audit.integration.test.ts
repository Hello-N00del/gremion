// T2 (#320 contestability) — DB-backed audit-coupling tests for the
// resolution-challenge service, mirroring the G-103 pattern of
// audit-db.integration.test.ts.
//
// Civitas Governance Core INV-1: every challenge act appends a tamper-evident
// audit_log row IN THE SAME TRANSACTION as the act itself (sql.begin +
// writeAuditEntry(entry, tx), audit-db.ts:27-33). Pinned here:
//   (1) filing → the challenge row AND a 'resolution_challenge.raised' audit
//       row commit together;
//   (2) deciding → a 'resolution_challenge.decided' audit row commits with the
//       disposition — and protocol_resolutions.result is NEVER modified by a
//       challenge act (challenges are a recorded channel, not auto-reversal);
//   (3) a post-INSERT failure injected inside the service tx (after BOTH the
//       act INSERT and the audit INSERT) rolls back EVERYTHING — neither the
//       challenge row nor the audit row persists.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getDb } from '../db'
import { createOrgUnit } from './org-units-db'
import { createProtocol, addResolution } from '../protocols/protocol-db'

// Failure injection seam for test (3): wrap the REAL writeAuditEntry so the
// audit row IS inserted on the caller's tx, then throw — a post-INSERT failure
// INSIDE the service transaction. With the flag off, behaviour is byte-identical
// to the real module.
const failpoint = vi.hoisted(() => ({ afterAuditInsert: false }))
vi.mock('$lib/server/audit-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/audit-db')>()
  return {
    ...actual,
    writeAuditEntry: async (
      ...args: Parameters<typeof actual.writeAuditEntry>
    ): Promise<void> => {
      await actual.writeAuditEntry(...args)
      if (failpoint.afterAuditInsert) {
        throw new Error('injected post-INSERT failure (tx atomicity probe)')
      }
    },
  }
})

const { fileChallenge, decideChallenge } = await import('./resolution-challenges-db')

async function seedResolution() {
  const unit = await createOrgUnit({
    name: 'Rat', description: null, parentId: null, kind: 'council',
    visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
  })
  const protocol = await createProtocol({
    committeeId: unit.id, meetingDate: '2026-07-01', title: 'Sitzung', createdBy: 'chair-1',
  })
  const resolution = await addResolution(protocol.id, {
    text: 'Beschluss A', votesYes: 3, votesNo: 1, votesAbstain: 0,
    result: 'passed', requiredMajority: 'simple',
  })
  // #437: the channel only accepts ADOPTED resolutions. Adoption is stamped by
  // recordResolutionAdoptions inside the publish tx; this helper adds
  // resolutions directly without publishing, so stamp decided_at here to model
  // an adopted Beschluss. Without this every case below files against a
  // never-adopted row — which is exactly the bug #437 closes.
  const sql = getDb()
  await sql`UPDATE protocol_resolutions SET decided_at = now() WHERE id = ${resolution.id}`
  return resolution
}

/** Deliberately NOT adopted — decided_at stays NULL (protocol never published). */
async function seedUnadoptedResolution() {
  const unit = await createOrgUnit({
    name: 'Rat', description: null, parentId: null, kind: 'council',
    visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
  })
  const protocol = await createProtocol({
    committeeId: unit.id, meetingDate: '2026-07-01', title: 'Sitzung', createdBy: 'chair-1',
  })
  return addResolution(protocol.id, {
    text: 'Beschluss A', votesYes: 3, votesNo: 1, votesAbstain: 0,
    result: 'passed', requiredMajority: 'simple',
  })
}

async function auditRows(field: string) {
  const sql = getDb()
  return sql<{ user_id: string; old_value: string | null; new_value: string }[]>`
    SELECT user_id, old_value, new_value FROM audit_log WHERE field = ${field} ORDER BY id
  `
}

describe('resolution-challenges same-tx INV-1 audit coupling', () => {
  beforeEach(async () => {
    failpoint.afterAuditInsert = false
    const sql = getDb()
    await sql`DELETE FROM resolution_challenges`
    await sql`DELETE FROM protocols`
    await sql`DELETE FROM org_units`
    await sql`TRUNCATE audit_log RESTART IDENTITY CASCADE`
  })

  it('(0) #437: filing against a never-adopted resolution is refused and writes NOTHING', async () => {
    // The FK catch in fileChallenge proves the row EXISTS; it says nothing about
    // whether the decision was ever binding. A resolution on a still-draft
    // protocol has decided_at NULL and must not be contestable — otherwise the
    // tamper-evident log gains a 'raised' entry for an act that never happened.
    const resolution = await seedUnadoptedResolution()

    await expect(
      fileChallenge({
        resolutionId: resolution.id,
        raisedBy: 'member-1',
        grounds: 'Verstoß gegen §7 der Geschäftsordnung',
      }),
    ).rejects.toMatchObject({ name: 'ResolutionNotAdoptedError' })

    const sql = getDb()
    const [{ count }] = await sql<{ count: string }[]>`SELECT count(*) FROM resolution_challenges`
    expect(Number(count)).toBe(0)
    expect(await auditRows('resolution_challenge.raised')).toHaveLength(0)
  })

  it("(1) filing commits the challenge row + a 'resolution_challenge.raised' audit row together", async () => {
    const resolution = await seedResolution()

    const challenge = await fileChallenge({
      resolutionId: resolution.id,
      raisedBy: 'member-1',
      grounds: 'Verstoß gegen §7 der Geschäftsordnung',
    })
    expect(challenge.status).toBe('open')
    expect(challenge.resolution_id).toBe(resolution.id)

    const audits = await auditRows('resolution_challenge.raised')
    expect(audits).toHaveLength(1)
    expect(audits[0].user_id).toBe('member-1')
    const payload = JSON.parse(audits[0].new_value)
    expect(payload).toMatchObject({ challengeId: challenge.id, resolutionId: resolution.id })
  })

  it('(1b) a second open challenge by the same user is refused (duplicate-open) and leaves no extra audit row', async () => {
    const resolution = await seedResolution()
    await fileChallenge({
      resolutionId: resolution.id, raisedBy: 'member-1', grounds: 'Erster Einspruch',
    })
    await expect(
      fileChallenge({
        resolutionId: resolution.id, raisedBy: 'member-1', grounds: 'Zweiter Einspruch',
      }),
    ).rejects.toMatchObject({ name: 'DuplicateOpenChallengeError' })

    const sql = getDb()
    const [{ count }] = await sql<{ count: string }[]>`SELECT count(*) FROM resolution_challenges`
    expect(Number(count)).toBe(1)
    expect(await auditRows('resolution_challenge.raised')).toHaveLength(1)
  })

  it("(2) deciding commits a 'resolution_challenge.decided' audit row — and NEVER touches protocol_resolutions.result", async () => {
    const resolution = await seedResolution()
    const challenge = await fileChallenge({
      resolutionId: resolution.id, raisedBy: 'member-1', grounds: 'Verstoß gegen §7',
    })

    const decided = await decideChallenge({
      challengeId: challenge.id,
      resolutionId: resolution.id,
      resolvedBy: 'admin-1',
      status: 'upheld',
      decisionNote: 'Frist war tatsächlich verletzt',
    })
    expect(decided.status).toBe('upheld')
    expect(decided.resolved_by).toBe('admin-1')
    expect(decided.decision_note).toBe('Frist war tatsächlich verletzt')

    const audits = await auditRows('resolution_challenge.decided')
    expect(audits).toHaveLength(1)
    expect(audits[0].user_id).toBe('admin-1')
    expect(audits[0].old_value).toBe('open')
    const payload = JSON.parse(audits[0].new_value)
    expect(payload).toMatchObject({
      challengeId: challenge.id,
      resolutionId: resolution.id,
      status: 'upheld',
    })

    // Contestability is a RECORDED channel, not auto-reversal: even an upheld
    // challenge never modifies the binding result on protocol_resolutions.
    const sql = getDb()
    const [row] = await sql<{ result: string }[]>`
      SELECT result FROM protocol_resolutions WHERE id = ${resolution.id}
    `
    expect(row.result).toBe('passed')
  })

  it('(3) an injected post-INSERT failure inside the FILING tx persists NEITHER the challenge row NOR the audit row', async () => {
    const resolution = await seedResolution()
    failpoint.afterAuditInsert = true

    await expect(
      fileChallenge({
        resolutionId: resolution.id, raisedBy: 'member-1', grounds: 'Verstoß gegen §7',
      }),
    ).rejects.toThrow('injected post-INSERT failure')

    const sql = getDb()
    const [{ count }] = await sql<{ count: string }[]>`SELECT count(*) FROM resolution_challenges`
    expect(Number(count)).toBe(0)
    expect(await auditRows('resolution_challenge.raised')).toHaveLength(0)
  })

  it('(3b) an injected post-INSERT failure inside the DISPOSITION tx rolls back both the status flip and the audit row', async () => {
    const resolution = await seedResolution()
    const challenge = await fileChallenge({
      resolutionId: resolution.id, raisedBy: 'member-1', grounds: 'Verstoß gegen §7',
    })
    failpoint.afterAuditInsert = true

    await expect(
      decideChallenge({
        challengeId: challenge.id,
        resolutionId: resolution.id,
        resolvedBy: 'admin-1',
        status: 'dismissed',
        decisionNote: null,
      }),
    ).rejects.toThrow('injected post-INSERT failure')

    const sql = getDb()
    const [row] = await sql<{ status: string; resolved_by: string | null }[]>`
      SELECT status, resolved_by FROM resolution_challenges WHERE id = ${challenge.id}
    `
    expect(row.status).toBe('open')
    expect(row.resolved_by).toBeNull()
    expect(await auditRows('resolution_challenge.decided')).toHaveLength(0)
  })
})
