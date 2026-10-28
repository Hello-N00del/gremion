// TRD-196 — the kernel's own erasure step: the subject's users/memberships/role
// data in the tenant DB. Runs as the module id `kernel`; it also answers for the
// always-on (non-toggleable) core and governance manifests, whose subject data
// is exactly these tables.
//
//   deleted        org_unit_members, caucus_membership, role_assignments (their
//                  scheduled_notifications go with them), notification_read_marker,
//                  provisioning_member_ops rows already DONE (status 'ok')
//   enqueued       one durable remove-op (provisioning_member_ops, migration 0037)
//                  per provisioned subsystem of every unit the subject leaves, in
//                  the SAME tx as the membership delete (as removeUserEverywhere
//                  does): the reconcile worker drains them to remove the person
//                  from the Keycloak/Matrix/Nextcloud groups. A still-pending or
//                  failed op is NEVER deleted: that would cancel the external
//                  removal while this step says "erased".
//   pseudonymised  role_assignment_history.user_keycloak_id -> NULL (migration
//                  0012: the office history stays, the person does not),
//                  role_assignments.assigned_by_keycloak_id -> 'erased'
//
// NOT touched, by design: audit_log (hash chain, TRD-160 redaction layer) and
// the protocol/Beschluss register (open conflict, TRD section 2.4). The external
// identities themselves are the separate `identity` step (identity-hook.ts),
// which stays `skipped` while the queued remove-ops are pending.
import type { Sql } from '@gremion/db'
import type { ModuleErasureHook } from '@gremion/ports/erasure'
import type { PgTransaction } from '$lib/server/db/tx'
import { enqueueMemberRemoveOps } from '$lib/server/governance/provisioning/member-ops'
import type { Subsystem } from '$lib/server/governance/provisioning/types'

export const KERNEL_MODULE_ID = 'kernel'
export const ERASED_MARKER = 'erased'

export const kernelErasureHook: ModuleErasureHook<Sql> = {
  moduleId: KERNEL_MODULE_ID,
  async erase({ db, subjectId }) {
    // The orchestrator never passes null to a connection-requiring hook; guard anyway.
    if (db === null) return { status: 'skipped', reason: 'no database connection' }
    const counts = await db.begin(async (tx) => {
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
      return c
    })
    return { status: 'erased', counts }
  },
}
