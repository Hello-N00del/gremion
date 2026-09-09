// src/routes/members/committees/[id]/+page.server.ts
import type { PageServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { listOrgUnitMembers, isMemberOf } from '$lib/server/governance/org-units-db'
import { listRoles, listHistory, getActiveAssignment } from '$lib/server/governance/governance-db'
import { getResources } from '$lib/server/governance/provisioning/ledger'
import { getKeycloakAdminClient } from '$lib/server/keycloak-admin'

export const load: PageServerLoad = async ({ params, locals, parent }) => {
  const { committee } = await parent() // an OrgUnit, supplied by the layout
  const session = await locals.auth()
  const user = session!.user as SessionUser

  const [members, roles, history, resources] = await Promise.all([
    listOrgUnitMembers(params.id),
    listRoles(params.id),
    listHistory(params.id),
    getResources(params.id)
  ])

  const rolesWithAssignment = await Promise.all(
    roles.map(async (r) => ({ ...r, currentAssignment: await getActiveAssignment(r.id) }))
  )

  const isMember = await isMemberOf(params.id, user.id)
  const isAdmin = hasRole(user.roles, Role.CouncilAdmin)

  const memberIds = members.map((m) => m.user_keycloak_id)
  const assignedIds = rolesWithAssignment
    .map((r) => r.currentAssignment?.user_keycloak_id)
    .filter((id): id is string => !!id)
  const allIds = [...new Set([...memberIds, ...assignedIds])]

  // Names are resolved live from Keycloak — never cached in the DB (GDPR §7).
  const userMap: Record<string, string> = {}
  await Promise.allSettled(
    allIds.map(async (id) => {
      try {
        const kcUser = await getKeycloakAdminClient(locals.tenant).getUser(id)
        userMap[id] = [kcUser.firstName, kcUser.lastName].filter(Boolean).join(' ') || kcUser.username
      } catch {
        userMap[id] = id
      }
    })
  )

  return {
    committee,
    members: members.map((m) => ({ ...m, displayName: userMap[m.user_keycloak_id] ?? m.user_keycloak_id })),
    roles: rolesWithAssignment.map((r) => ({
      ...r,
      currentAssignment: r.currentAssignment
        ? { ...r.currentAssignment, displayName: userMap[r.currentAssignment.user_keycloak_id] ?? r.currentAssignment.user_keycloak_id }
        : null
    })),
    history: history.map((h) => ({
      ...h,
      user_keycloak_id: h.user_keycloak_id === null
        ? '[gelöschtes Mitglied]'
        : (isMember || isAdmin) ? (userMap[h.user_keycloak_id] ?? h.user_keycloak_id) : '[redacted]'
    })),
    resources: resources.map((r) => ({
      subsystem: r.subsystem, status: r.status, last_error: r.last_error, updated_at: r.updated_at
    })),
    user, isAdmin
  }
}
