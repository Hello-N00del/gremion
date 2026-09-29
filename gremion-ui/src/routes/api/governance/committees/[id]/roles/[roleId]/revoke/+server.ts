// src/routes/api/governance/committees/[id]/roles/[roleId]/revoke/+server.ts
// #320 Phase 3 / INV-3 recall: the contestability/recall channel. Recalling a
// mandate is a recorded, attributable governance act — revokeMandate archives
// the assignment as 'recalled' and appends the 'mandate.revoked' audit act in
// ONE transaction. Afterwards the revoked holder's flat-Keycloak-group grants
// are reconciled through the SAME role-group-reconcile module the assign route
// uses (audit 420: single reconcile decision, no duplicated add/revoke logic),
// best-effort — a KC hiccup never un-does the committed recall.
import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import {
  getActiveAssignment, revokeMandate, UnarchivableAssignmentError
} from '$lib/server/governance/governance-db'
import { reconcileUserRoleGroups } from '$lib/server/governance/role-group-reconcile'
import { getKeycloakAdminClientForCurrentTenant } from '$lib/server/keycloak-admin'

// INV-3: a recall is only valid WITH a recorded free-text reason.
const revokeSchema = z.object({
  reason: z.string().trim().min(1, 'reason is required').max(4000, 'reason is too long')
})

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const body = await request.json()
  const parsed = revokeSchema.safeParse(body)
  if (!parsed.success) {
    return json(
      { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') },
      { status: 400 }
    )
  }

  const assignment = await getActiveAssignment(params.roleId)
  if (!assignment) {
    return json({ success: false, error: 'No active assignment for this role' }, { status: 404 })
  }

  try {
    await revokeMandate(assignment, parsed.data.reason, user.id)
  } catch (err) {
    // An assignment with NULL start/end dates cannot be archived (migration
    // 010 vs history NOT NULL) — a data-shape conflict, not a server fault.
    if (err instanceof UnarchivableAssignmentError) {
      return json({ success: false, error: err.message }, { status: 409 })
    }
    throw err
  }

  // Recall committed — now converge the revoked holder's auto-managed flat
  // groups (audit 420). The recorded recall stands either way, but a failed
  // cleanup is REPORTED (TASK-206-A review): a recalled holder usually sees no
  // further mutation, so "the next one converges it" may never happen, and the
  // admin has to know the holder may still carry module groups.
  let groupsReconciled = true
  try {
    const kc = getKeycloakAdminClientForCurrentTenant()
    await reconcileUserRoleGroups(assignment.user_keycloak_id, kc)
  } catch (err) {
    groupsReconciled = false
    console.error(
      '[governance/roles/revoke] flat-group reconcile failed after the recall was recorded:',
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    )
  }

  return json({ success: true, groupsReconciled }, { status: 200 })
}
