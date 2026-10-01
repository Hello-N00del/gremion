import type { PageServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { listMembers } from '$lib/server/members/member-view'

// WI-4B unified Mitglieder loader. No group-based 403: every signed-in member
// reaches /members; admins (Vorstand / IT-Team) get the everyone-incl-invited
// admin list, basic members get placed + active people only. The friendly
// Member projection guarantees zero Keycloak/UUID/group-id leakage.
export const load: PageServerLoad = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  const isAdmin = !!user && (hasRole(user.roles, Role.CouncilAdmin) || hasRole(user.roles, Role.ITAdmin))
  // R29-F104-KTWIN (D-3): the basic view hides memberships of committee_only
  // units the viewer is not in.
  const viewer = user ? { id: user.id, roles: user.roles ?? [] } : null
  const members = await listMembers({ adminView: isAdmin, viewer })
  return { members, isAdmin }
}
