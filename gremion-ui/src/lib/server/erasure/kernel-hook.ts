// TRD-196 — the kernel's own erasure step: the subject's users/memberships/role
// data in the tenant DB. Runs as the module id `kernel`; it also answers for the
// always-on (non-toggleable) core and governance manifests, whose subject data
// is exactly these tables.
//
//   deleted        org_unit_members, caucus_membership, role_assignments (their
//                  scheduled_notifications go with them), provisioning_member_ops
//                  rows still queued for the subject, notification_read_marker
//   pseudonymised  role_assignment_history.user_keycloak_id -> NULL (migration
//                  0012: the office history stays, the person does not),
//                  role_assignments.assigned_by_keycloak_id -> 'erased'
//
// NOT touched, by design: audit_log (hash chain, TRD-160 redaction layer) and
// the protocol/Beschluss register (open conflict, TRD section 2.4). External
// identities (Keycloak/Matrix/Nextcloud) are removed by removeUserEverywhere's
// fan-out, which is a network step and not part of this DB seam (named residual).
import type { Sql } from '@gremion/db'
import type { ModuleErasureHook } from '@gremion/ports/erasure'

export const KERNEL_MODULE_ID = 'kernel'
export const ERASED_MARKER = 'erased'

export const kernelErasureHook: ModuleErasureHook<Sql> = {
  moduleId: KERNEL_MODULE_ID,
  async erase({ db, subjectId }) {
    // The orchestrator never passes null to a connection-requiring hook; guard anyway.
    if (db === null) return { status: 'skipped', reason: 'no database connection' }
    const counts = await db.begin(async (tx) => {
      const c: Record<string, number> = {}
      c.org_unit_members = (await tx`DELETE FROM org_unit_members WHERE user_keycloak_id = ${subjectId}`).count
      c.caucus_membership = (await tx`DELETE FROM caucus_membership WHERE user_keycloak_id = ${subjectId}`).count
      c.provisioning_member_ops = (await tx`DELETE FROM provisioning_member_ops WHERE user_keycloak_id = ${subjectId}`).count
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
