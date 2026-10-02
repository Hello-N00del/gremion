import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { listRoles, createRole, getActiveAssignment } from '$lib/server/governance/governance-db'
import { getOrgUnit, isMemberOf } from '$lib/server/governance/org-units-db'
import { canSeeOrgUnit, seesAllGovernance } from '$lib/server/governance/visibility'

const createRoleSchema = z.object({
  name: z.string().min(1).max(200),
  electionMethod: z.enum(['helios', 'poll', 'manual']).default('manual'),
  isElected: z.boolean().default(true),
  gracePeriodDays: z.number().int().min(1).max(90).default(14)
})

export const GET: RequestHandler = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  // R29-F104-KTWIN (kernel twin of F1-FIX-04 / S3#33, operator decision D-3):
  // role holders are roster data, so a committee_only unit's roles go only to
  // its members and CouncilAdmins. Same 404 as the members endpoint for a
  // hidden or missing unit.
  const unit = await getOrgUnit(params.id)
  if (!unit) return json({ success: false, error: 'Not found' }, { status: 404 })
  const isUnitMember = seesAllGovernance(user) ? false : await isMemberOf(params.id, user.id)
  if (!canSeeOrgUnit(user, unit, isUnitMember)) {
    return json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const roles = await listRoles(params.id)
  const rolesWithAssignment = await Promise.all(
    roles.map(async (r) => ({ ...r, currentAssignment: await getActiveAssignment(r.id) }))
  )
  return json({ success: true, data: rolesWithAssignment })
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const body = await request.json()
  const parsed = createRoleSchema.safeParse(body)
  if (!parsed.success) {
    return json(
      { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') },
      { status: 400 }
    )
  }
  const role = await createRole({ orgUnitId: params.id, ...parsed.data })
  return json({ success: true, data: role }, { status: 201 })
}
