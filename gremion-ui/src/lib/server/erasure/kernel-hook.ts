// TRD-196 — the kernel's own erasure step: the subject's users/memberships/role
// data in the tenant DB. Runs as the module id `kernel`; it also answers for the
// always-on (non-toggleable) core and governance manifests, whose subject data
// is exactly these tables.
//
// Per-table policy (docs/compliance/retention-catalogue.md):
//
//   RC-IDT-TENURE (tenures, governance memberships: record period, pseudonymised
//   on request, TRD-160) -- KEPT AS A RECORD, the person removed:
//     role_assignments        every row of the subject (active, grace, expired,
//                             vacated) is first copied into role_assignment_history
//                             with user_keycloak_id NULL, then the live row is
//                             deleted (its scheduled_notifications cascade).
//                             ended_reason: expired|grace -> 'expired',
//                             active|vacated -> 'removed'; end_date: the term end,
//                             capped at today for a still-running term, today when
//                             open. A not-yet-started assignment is not a tenure
//                             and is only deleted.
//     role_assignment_history user_keycloak_id -> NULL (migration 0012).
//     org_unit_members        an ELECTED row is copied into
//     caucus_membership       governance_membership_record (migration 0060, no
//                             subject column) and the live row deleted; a caucus
//                             seat likewise. The live row cannot keep a pseudonym:
//                             it drives the reconcile worker's add-only member sync.
//     role_assignments.assigned_by_keycloak_id -> 'erased' (the act stays, the
//                             actor does not).
//   RC-IDT-HELPER / operative data -- DELETED:
//     org_unit_members (unelected, employee), notification_read_marker,
//     scheduled_notifications, provisioning_member_ops already DONE (status 'ok').
//   RC-BRD (board cards: operative, not a register record) -- PSEUDONYMISED:
//     card.assignee_keycloak_id, card.created_by -> NULL (the card stays for the
//     body, the person does not). The table is kernel-applied (0034), so this
//     runs even when the board module is off.
//   Register records -- KEPT, reported as residuals (table, column, rows, reason):
//     protocols.created_by, protocol_attendance.user_keycloak_id,
//     protocol_action_items.assignee_keycloak_id (RC-GOV-PROT: the protocol
//     record, action items included), resolution_challenges.raised_by/resolved_by
//     (Beschluss register), committee_elections.created_by (election record),
//     audit_log.user_id (hash chain), erasure_report.requested_by (the
//     accountability of erasures this person requested). Their redaction is
//     TRD-160's; a column is listed only while it still holds the subject.
//   Erasure processing -- ENQUEUED, never cancelled:
//     provisioning_member_ops one durable remove-op (migration 0037) per
//                             provisioned subsystem of every unit the subject
//                             leaves, in the SAME tx as the membership delete (as
//                             removeUserEverywhere does); the reconcile worker
//                             drains them (Keycloak/Matrix/Nextcloud groups). A
//                             pending or failed op is NEVER deleted.
//
// NOT touched, by design: audit_log (hash chain, TRD-160 redaction layer) and
// the protocol/Beschluss register (open conflict, TRD section 2.4). The external
// identities themselves are the separate `identity` step (identity-hook.ts),
// which stays `skipped` while the queued remove-ops are pending.
import type { Sql } from '@gremion/db'
import type { ErasureResidual, ModuleErasureHook } from '@gremion/ports/erasure'
import type { PgTransaction } from '$lib/server/db/tx'
import { enqueueMemberRemoveOps } from '$lib/server/governance/provisioning/member-ops'
import type { Subsystem } from '$lib/server/governance/provisioning/types'

export const KERNEL_MODULE_ID = 'kernel'
export const ERASED_MARKER = 'erased'

const PROTOCOL_RECORD = "council record (RC-GOV-PROT, record period): redaction is TRD-160's, not this seam's"
const REGISTER_RECORD = "Beschluss register (record period): redaction is TRD-160's, not this seam's"

/** Subject-id columns the kernel step deliberately leaves, and why. */
export const KERNEL_RESIDUAL_COLUMNS: readonly Omit<ErasureResidual, 'rows'>[] = [
  { table: 'protocols', column: 'created_by', reason: PROTOCOL_RECORD },
  { table: 'protocol_attendance', column: 'user_keycloak_id', reason: PROTOCOL_RECORD },
  { table: 'protocol_action_items', column: 'assignee_keycloak_id', reason: PROTOCOL_RECORD },
  { table: 'resolution_challenges', column: 'raised_by', reason: REGISTER_RECORD },
  { table: 'resolution_challenges', column: 'resolved_by', reason: REGISTER_RECORD },
  {
    table: 'committee_elections',
    column: 'created_by',
    reason: "election record (record period): redaction is TRD-160's, not this seam's",
  },
  { table: 'audit_log', column: 'user_id', reason: 'tamper-evident hash chain: redaction layer TRD-160' },
  {
    table: 'erasure_report',
    column: 'requested_by',
    reason: 'accountability record of erasures this person requested (record period)',
  },
]

export const kernelErasureHook: ModuleErasureHook<Sql> = {
  moduleId: KERNEL_MODULE_ID,
  async erase({ db, subjectId }) {
    // The orchestrator never passes null to a connection-requiring hook; guard anyway.
    if (db === null) return { status: 'skipped', reason: 'no database connection' }
    const { counts, residuals } = await db.begin(async (tx) => {
      const c: Record<string, number> = {}

      // HIGH-1: queue the external removals BEFORE the membership rows go, in this tx.
      // Same subsystem filter as removeUserEverywhere: any ledger row with an external
      // id still holds a live external resource (the drain is 404-tolerant for the rest).
      const units = await tx<{ org_unit_id: string }[]>`
        SELECT DISTINCT org_unit_id FROM org_unit_members WHERE user_keycloak_id = ${subjectId}`
      const resources = units.length === 0 ? [] : await tx<{ org_unit_id: string; subsystem: Subsystem }[]>`
        SELECT org_unit_id, subsystem FROM provisioning_resources
        WHERE external_id IS NOT NULL AND org_unit_id IN ${tx(units.map((u) => u.org_unit_id))}
        ORDER BY org_unit_id, subsystem`
      c.provisioning_member_ops_enqueued = 0
      for (const { org_unit_id: unitId } of units) {
        const subs = resources.filter((r) => r.org_unit_id === unitId).map((r) => r.subsystem)
        await enqueueMemberRemoveOps(tx as unknown as PgTransaction, unitId, subjectId, subs)
        c.provisioning_member_ops_enqueued += subs.length
      }
      // Only finished ops may go; pending/failed ones are the outbox of the external removal.
      c.provisioning_member_ops_done_purged = (
        await tx`DELETE FROM provisioning_member_ops WHERE user_keycloak_id = ${subjectId} AND status = 'ok'`
      ).count

      // HIGH-2 (RC-IDT-TENURE): the governance record survives, the person does not.
      c.governance_membership_record = (
        await tx`
          INSERT INTO governance_membership_record
            (source, org_unit_id, caucus_id, membership_type, voting, term_start, term_end, joined_at)
          SELECT 'org_unit_members', org_unit_id, NULL, membership_type, voting, term_start, term_end, joined_at
          FROM org_unit_members WHERE user_keycloak_id = ${subjectId} AND membership_type = 'elected'
          UNION ALL
          SELECT 'caucus_membership', council_org_unit_id, caucus_id, NULL, NULL, term_start, term_end, joined_at
          FROM caucus_membership WHERE user_keycloak_id = ${subjectId}`
      ).count
      c.role_assignment_history_archived = (
        await tx`
          INSERT INTO role_assignment_history (role_id, user_keycloak_id, start_date, end_date, ended_reason)
          SELECT role_id, NULL, s, e, r FROM (
            SELECT role_id,
                   COALESCE(start_date, created_at::date) AS s,
                   CASE WHEN status IN ('active', 'grace')
                        THEN LEAST(COALESCE(end_date, current_date), current_date)
                        ELSE COALESCE(end_date, current_date) END AS e,
                   CASE WHEN status IN ('expired', 'grace') THEN 'expired' ELSE 'removed' END AS r
            FROM role_assignments WHERE user_keycloak_id = ${subjectId}
          ) t
          WHERE s <= e`
      ).count

      c.org_unit_members = (await tx`DELETE FROM org_unit_members WHERE user_keycloak_id = ${subjectId}`).count
      c.caucus_membership = (await tx`DELETE FROM caucus_membership WHERE user_keycloak_id = ${subjectId}`).count
      c.notification_read_marker = (await tx`DELETE FROM notification_read_marker WHERE user_keycloak_id = ${subjectId}`).count
      c.scheduled_notifications = (await tx`DELETE FROM scheduled_notifications WHERE recipient_keycloak_id = ${subjectId}`).count
      c.role_assignments = (await tx`DELETE FROM role_assignments WHERE user_keycloak_id = ${subjectId}`).count
      c.role_assignments_assigned_by = (
        await tx`UPDATE role_assignments SET assigned_by_keycloak_id = ${ERASED_MARKER} WHERE assigned_by_keycloak_id = ${subjectId}`
      ).count
      c.role_assignment_history = (
        await tx`UPDATE role_assignment_history SET user_keycloak_id = NULL WHERE user_keycloak_id = ${subjectId}`
      ).count

      // RC-BRD: operative board data, not a register record.
      c.card_assignee = (await tx`UPDATE card SET assignee_keycloak_id = NULL WHERE assignee_keycloak_id = ${subjectId}`).count
      c.card_created_by = (await tx`UPDATE card SET created_by = NULL WHERE created_by = ${subjectId}`).count

      // What stays, said out loud (MED-3): counted inside the same tx, after the writes.
      const left: ErasureResidual[] = []
      for (const col of KERNEL_RESIDUAL_COLUMNS) {
        const [{ n }] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM ${tx(col.table)} WHERE ${tx(col.column)}::text = ${subjectId}`
        if (n > 0) left.push({ ...col, rows: n })
      }
      return { counts: c, residuals: left }
    })
    return { status: 'erased', counts, residuals }
  },
}
