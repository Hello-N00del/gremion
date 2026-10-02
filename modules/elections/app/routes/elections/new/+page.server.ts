import { error } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { listOrgUnits, type OrgUnit } from '$lib/server/governance/org-units-db'

export interface WizardCommittee {
  id: string
  name: string
}

export const load: PageServerLoad = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) {
    error(403, 'Forbidden')
  }
  if (!hasRole(user.roles, Role.CouncilAdmin) && !hasRole(user.roles, Role.ITAdmin)) {
    error(403, 'Nur Council-Admins und IT-Admins dürfen Wahlen anlegen.')
  }

  let orgUnits: readonly OrgUnit[] = []
  try {
    orgUnits = await listOrgUnits()
  } catch {
    orgUnits = []
  }

  const shaped: WizardCommittee[] = orgUnits.map((u) => ({
    id: u.id,
    name: u.name,
  }))

  return { committees: shaped }
}
