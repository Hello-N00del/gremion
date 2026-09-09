import type { LayoutServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { redirect, error } from '@sveltejs/kit'
import { getOrgUnit } from '$lib/server/governance/org-units-db'

export const load: LayoutServerLoad = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) throw redirect(303, '/auth/login')

  const committee = await getOrgUnit(params.id)
  if (!committee) throw error(404, 'Committee not found')

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
