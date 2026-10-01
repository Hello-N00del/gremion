import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { listHistory } from '$lib/server/governance/governance-db'
import { getOrgUnit, isMemberOf } from '$lib/server/governance/org-units-db'
import { canSeeOrgUnit } from '$lib/server/governance/visibility'

export const GET: RequestHandler = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const unit = await getOrgUnit(params.id)
  if (!unit) return json({ success: false, error: 'Not found' }, { status: 404 })

  // R29-F104-KTWIN (kernel twin of F1-FIX-04 / S3#33, operator decision D-3): a
  // committee_only unit's membership history goes only to its members and
  // CouncilAdmins; the same 404 as for a missing unit, so its existence does
  // not leak.
  const isMember = await isMemberOf(params.id, user.id)
  if (!canSeeOrgUnit(user, unit, isMember)) {
    return json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const history = await listHistory(params.id)
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
