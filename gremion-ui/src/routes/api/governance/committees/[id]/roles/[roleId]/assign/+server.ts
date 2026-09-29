import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import {
  createAssignment, getActiveAssignment, archiveAssignment, scheduleNotifications
} from '$lib/server/governance/governance-db'
import { listOrgUnitMembers } from '$lib/server/governance/org-units-db'
import { reconcileUserRoleGroups } from '$lib/server/governance/role-group-reconcile'
import { getKeycloakAdminClientForCurrentTenant } from '$lib/server/keycloak-admin'

const assignSchema = z.object({
  userKeycloakId: z.string().min(1),
  startDate: z.string().date(),
  endDate: z.string().date(),
  heliosElectionId: z.string().nullable().default(null)
})

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const body = await request.json()
  const parsed = assignSchema.safeParse(body)
  if (!parsed.success) {
    return json(
      { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') },
      { status: 400 }
    )
  }

  const existing = await getActiveAssignment(params.roleId)
  if (existing) {
    await archiveAssignment(existing, 'removed')
  }

  const assignment = await createAssignment({
    roleId: params.roleId,
    userKeycloakId: parsed.data.userKeycloakId,
    startDate: new Date(parsed.data.startDate),
    endDate: new Date(parsed.data.endDate),
    assignedByKeycloakId: user.id,
    heliosElectionId: parsed.data.heliosElectionId
  })

  // Per design decision D4: roles and membership are independent.
  // Assigning a role no longer silently joins the user to the Keycloak group.
  // Membership is managed explicitly through the member panel / orchestrator.

  // #410 FIN-2 (B2): module-declared FLAT-group grants for this role (e.g. the
  // finance officer roles → ref-finanzen*). Distinct from D4 above — these are
  // module AUTHZ function groups, not the org-unit membership group. Best-effort
  // (idempotent KC PUT/DELETE): a KC hiccup must not fail the created assignment;
  // the next mutation (or a seed re-run) converges it.
  //
  // Audit 420 (item 1): the grant used to be ADD-ONLY, so when a role changed
  // hands the OUTGOING holder kept ref-finanzen* — hence finance authz — forever
  // (authz is derived at request time from the KC `groups` claim: scope.ts
  // hasFinanceGroup / group-helpers.ts). reconcileUserRoleGroups (role-group-
  // reconcile.ts) now sets each affected user's auto-managed groups to exactly
  // what their remaining active assignments derive — reconciling the incoming
  // holder covers assign/re-assign; reconciling a DIFFERENT outgoing holder
  // covers unassign (a user who still holds the group via another live
  // assignment keeps it — no over-revoke — and a manually-assigned group like
  // -belege, outside the auto-managed universe, is never touched).
  try {
    const kc = getKeycloakAdminClientForCurrentTenant()
    const groupIdByName = new Map((await kc.listGroups()).map((g) => [g.name, g.id]))
    // Outgoing holder FIRST, in its own guard: the revoke is the security-
    // relevant half, so a failure reconciling the incoming holder (e.g. a KC
    // 404 on a never-validated user id) must never skip it.
    // The just-archived assignment is already gone, so reconciling a different
    // outgoing holder sees only what they still hold. A renewal of the SAME user
    // needs no second reconcile — the incoming call below covers them.
    if (existing && existing.user_keycloak_id !== parsed.data.userKeycloakId) {
      try {
        await reconcileUserRoleGroups(existing.user_keycloak_id, kc, groupIdByName)
      } catch (err) {
        console.error('[governance/roles/assign] outgoing-holder reconcile failed:', err)
      }
    }
    await reconcileUserRoleGroups(parsed.data.userKeycloakId, kc, groupIdByName)
  } catch (err) {
    console.error('[governance/roles/assign] flat-group reconcile failed:', err)
  }

  const members = await listOrgUnitMembers(params.id)
  const memberIds = members.map((m) => m.user_keycloak_id)
  await scheduleNotifications(assignment, [parsed.data.userKeycloakId, ...memberIds])

  return json({ success: true, data: assignment }, { status: 201 })
}
