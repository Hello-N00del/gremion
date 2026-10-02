import { error } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { readConfig } from '$lib/server/config'
import { serviceEnv } from '$lib/server/env/service-env'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || (!hasRole(user.roles, Role.CouncilAdmin) && !hasRole(user.roles, Role.ITAdmin))) {
    error(403, 'Nur Council-Admins dürfen Wahlen verwalten.')
  }

  const config = readConfig()
  const trackedUuids = config.elections?.tracked_uuids ?? []
  const heliosBase = (serviceEnv('HELIOS_URL') ?? 'http://helios:8000').replace(/\/$/, '')
  const heliosAdminUrl = `${heliosBase}/helios`

  return {
    trackedUuids,
    heliosAdminUrl,
  }
}
