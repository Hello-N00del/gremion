// revoke-mandate.integration.test.ts — #320 Phase 3 / INV-3 recall.
// Ending a mandate is a recorded, attributable governance act: revokeMandate
// must, in ONE transaction, (1) delete the live role_assignments row,
// (2) insert the role_assignment_history row with ended_reason='recalled', and
// (3) append the tamper-evident audit_log act 'mandate.revoked' whose payload
// carries the assignment id, the free-text reason, and the acting revoker.
// Only a real DB can prove the atomicity (and the widened ended_reason CHECK
// from migration 055 + the hash-chain trigger from 043 live in the DB).
//
// The rollback case injects a failure AFTER the history INSERT (and after the
// DELETE + the audit INSERT — all three writes have executed on the tx) and
// proves ALL THREE roll back. That is only possible because archiveAssignment
// gained an optional-tx path via getRunner — previously it was two
// non-transactional pool statements that would have auto-committed.
//
// The route-level wiring (403/400/404, UnarchivableAssignmentError → clean 4xx,
// KC reconcile delegation) is pinned in the mocked unit test
// routes/api/governance/committees/[id]/roles/[roleId]/revoke/revoke.reconcile.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getDb } from '../db'
import { createOrgUnit } from './org-units-db'
import { readAuditLog, verifyAuditChain } from '../audit-db'
import {
  createRole, createAssignment, getActiveAssignment,
  revokeMandate, UnarchivableAssignmentError,
  type RoleAssignment,
} from './governance-db'

// Failure injection for the rollback proof: passthrough to the REAL
// writeAuditEntry (so the audit INSERT genuinely executes on the tx), then
// throw — simulating a crash after every write of the recall act.
const inject = vi.hoisted(() => ({ failAfterAudit: false }))
vi.mock('$lib/server/audit-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/audit-db')>()
  return {
    ...actual,
    writeAuditEntry: vi.fn(async (...args: Parameters<typeof actual.writeAuditEntry>) => {
      await actual.writeAuditEntry(...args)
      if (inject.failAfterAudit) throw new Error('injected failure after history INSERT')
    }),
  }
})

const ACTOR = 'council-admin-1'
const HOLDER = 'holder-kc-1'

async function seedAssignment(): Promise<RoleAssignment> {
  const unit = await createOrgUnit({
    name: 'Vorstand', description: null, parentId: null, kind: 'committee',
    visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
  })
  const role = await createRole({
    orgUnitId: unit.id, name: 'Finanzvorstand',
    electionMethod: 'manual', isElected: false, gracePeriodDays: 0,
  })
  return createAssignment({
    roleId: role.id, userKeycloakId: HOLDER,
    startDate: new Date('2026-01-01'), endDate: new Date('2027-01-01'),
    assignedByKeycloakId: ACTOR, heliosElectionId: null,
  })
}

describe('#320 INV-3 revokeMandate (integration)', () => {
  beforeEach(async () => {
    inject.failAfterAudit = false
    const sql = getDb()
    await sql`TRUNCATE audit_log RESTART IDENTITY CASCADE`
    // Kernel lane convention (governance-db.integration.test.ts): other files
    // leave protocols referencing org units; CASCADE clears them first.
    await sql`TRUNCATE org_units RESTART IDENTITY CASCADE`
    await sql`DELETE FROM role_assignment_history`
    await sql`DELETE FROM role_assignments`
    await sql`DELETE FROM committee_roles`
    await sql`DELETE FROM org_unit_members`
    await sql`DELETE FROM committee_elections`
    await sql`DELETE FROM org_units`
  })

  it('recall deletes the live assignment, archives it as recalled, and records the mandate.revoked act', async () => {
    const assignment = await seedAssignment()
    const sql = getDb()

    await revokeMandate(assignment, 'Abwahl per Beschluss 2026/42', ACTOR)

    // (1) the live role_assignments row is gone.
    expect(await getActiveAssignment(assignment.role_id)).toBeNull()
    const liveRows = await sql`SELECT id FROM role_assignments WHERE id = ${assignment.id}`
    expect(liveRows).toHaveLength(0)

    // (2) exactly one history row, ended_reason 'recalled' (widened union +
    // widened CHECK constraint, migration 055), dates carried over.
    const history = await sql<{
      role_id: string; user_keycloak_id: string | null; ended_reason: string
      start_date: Date; end_date: Date
    }[]>`SELECT * FROM role_assignment_history`
    expect(history).toHaveLength(1)
    expect(history[0]!.role_id).toBe(assignment.role_id)
    expect(history[0]!.user_keycloak_id).toBe(HOLDER)
    expect(history[0]!.ended_reason).toBe('recalled')

    // (3) exactly one audit act 'mandate.revoked' with the full payload.
    const audits = await readAuditLog('mandate.revoked')
    expect(audits).toHaveLength(1)
    expect(audits[0]!.userId).toBe(ACTOR)
    expect(audits[0]!.oldValue).toBeNull()
    expect(JSON.parse(audits[0]!.newValue)).toEqual({
      assignmentId: assignment.id,
      reason: 'Abwahl per Beschluss 2026/42',
      revokedBy: ACTOR,
    })
    // The hash chain (INV-1) is intact after the recall act.
    expect(await verifyAuditChain()).toEqual({ ok: true })
  })

  it('an injected failure after the history INSERT rolls back ALL THREE writes (single tx via archiveAssignment getRunner path)', async () => {
    const assignment = await seedAssignment()
    const sql = getDb()
    inject.failAfterAudit = true

    await expect(
      revokeMandate(assignment, 'Abwahl per Beschluss 2026/43', ACTOR),
    ).rejects.toThrow('injected failure after history INSERT')

    // The history INSERT, the role_assignments DELETE and the audit INSERT all
    // executed before the injected failure — and ALL THREE rolled back. Were
    // archiveAssignment still two non-transactional pool statements, the
    // history row would have auto-committed and the live row would be gone.
    expect(await sql`SELECT id FROM role_assignments WHERE id = ${assignment.id}`).toHaveLength(1)
    expect(await sql`SELECT id FROM role_assignment_history`).toHaveLength(0)
    expect(await readAuditLog('mandate.revoked')).toHaveLength(0)
    // The holder still actively holds the role — the recall did NOT happen.
    expect((await getActiveAssignment(assignment.role_id))?.id).toBe(assignment.id)
  })

  it('an assignment with NULL start/end dates surfaces the archiveAssignment error (typed → the route maps it to a clean 4xx) and writes nothing', async () => {
    const seeded = await seedAssignment()
    const sql = getDb()
    // migration 010 made role_assignments dates nullable; history still
    // requires concrete dates — NULL them to hit archiveAssignment's guard.
    await sql`UPDATE role_assignments SET start_date = NULL, end_date = NULL WHERE id = ${seeded.id}`
    const assignment = (await getActiveAssignment(seeded.role_id))!
    expect(assignment.start_date).toBeNull()

    await expect(revokeMandate(assignment, 'x', ACTOR)).rejects.toThrow(UnarchivableAssignmentError)
    await expect(revokeMandate(assignment, 'x', ACTOR)).rejects.toThrow(
      /start_date or end_date is null/,
    )

    // Atomic no-op: the live row survives, no history, no audit act.
    expect(await sql`SELECT id FROM role_assignments WHERE id = ${seeded.id}`).toHaveLength(1)
    expect(await sql`SELECT id FROM role_assignment_history`).toHaveLength(0)
    expect(await readAuditLog('mandate.revoked')).toHaveLength(0)
  })
})
