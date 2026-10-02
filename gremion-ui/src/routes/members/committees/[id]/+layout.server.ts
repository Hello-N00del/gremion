import type { LayoutServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { redirect, error } from '@sveltejs/kit'
import { getOrgUnit, isMemberOf } from '$lib/server/governance/org-units-db'
import { canSeeOrgUnit, seesAllGovernance } from '$lib/server/governance/visibility'

export const load: LayoutServerLoad = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) throw redirect(303, '/auth/login')

  const committee = await getOrgUnit(params.id)
  if (!committee) throw error(404, 'Committee not found')

  // R29-F104-KTWIN (kernel twin of F1-FIX-04 / S3#33, operator decision D-3): a
  // committee_only unit is visible only to its members and CouncilAdmins. The
  // gate sits HERE so every nested loader (roster, protokolle, beschluesse,
  // protocol detail) inherits it through `await parent()`. 404, not 403, so the
  // unit's existence is not confirmed -- the same answer
  // GET /api/governance/committees/[id]/members gives.
  const viewer = { id: user.id, roles: user.roles ?? [] }
  const isUnitMember = seesAllGovernance(viewer) ? false : await isMemberOf(params.id, user.id)
  if (!canSeeOrgUnit(viewer, committee, isUnitMember)) throw error(404, 'Committee not found')

  return {
    committee,
    // Breadcrumb: hide the route-folder segment "committees" and show the
    // committee name in place of the UUID. Inherited by every nested route
    // under /members/committees/[id]/* (protokolle, beschluesse, ...).
    crumbOverrides: {
      committees: null,
      [params.id]: committee.name,
    },
  }
}
