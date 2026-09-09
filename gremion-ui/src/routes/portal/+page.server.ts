import { error } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { readConfig } from '$lib/server/config'

export const load: PageServerLoad = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    error(403, 'Forbidden')
  }

  const config = readConfig()
  return {
    domain: config.org.domain,
    portalSections: config.org.portal_sections,
  }
}
