import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { listHistory } from '$lib/server/governance/governance-db'
import { getOrgUnit, isMemberOf } from '$lib/server/governance/org-units-db'

export const GET: RequestHandler = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const unit = await getOrgUnit(params.id)
  if (!unit) return json({ success: false, error: 'Not found' }, { status: 404 })

  const history = await listHistory(params.id)
  const isMember = await isMemberOf(params.id, user.id)
  const isAdmin = hasRole(user.roles, Role.CouncilAdmin)
  const canSeePersonal = isMember || isAdmin

  const filtered = history.map((h) => ({
    ...h,
    user_keycloak_id: h.user_keycloak_id === null
      ? '[gelöschtes Mitglied]'
      : canSeePersonal ? h.user_keycloak_id : '[redacted]'
  }))

  return json({ success: true, data: filtered })
}
