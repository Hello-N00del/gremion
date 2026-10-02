// src/routes/api/governance/committees/[id]/members/+server.ts
import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { listOrgUnitMembers, getOrgUnit, isMemberOf } from '$lib/server/governance/org-units-db'
import { canSeeOrgUnit, seesAllGovernance } from '$lib/server/governance/visibility'
import { addMember } from '$lib/server/governance/provisioning/orchestrator'
import { getKeycloakAdminClient } from '$lib/server/keycloak-admin'
import { writeAuditEntry } from '$lib/server/audit-db'

const addMemberSchema = z.object({
  userKeycloakId: z.string().min(1),
  membershipType: z.enum(['elected', 'unelected', 'employee']).default('unelected'),
  termStart: z.string().date().nullable().default(null),
  termEnd: z.string().date().nullable().default(null)
})

export const GET: RequestHandler = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  // R29-F104-KTWIN (kernel twin of F1-FIX-04 / S3#33, operator decision D-3):
  // the unit must be visible to the caller (a committee_only unit only to its
  // members and CouncilAdmins), and email addresses go only to members of the
  // same unit or a CouncilAdmin (data minimisation, DSGVO Art. 5(1)(c)). The 404
  // for a hidden unit matches the one for a missing unit, so its existence does
  // not leak.
  const unit = await getOrgUnit(params.id)
  if (!unit) return json({ success: false, error: 'Not found' }, { status: 404 })
  const isUnitMember = seesAllGovernance(user) ? false : await isMemberOf(params.id, user.id)
  if (!canSeeOrgUnit(user, unit, isUnitMember)) {
    return json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const mayReadEmail = seesAllGovernance(user) || isUnitMember
  const members = await listOrgUnitMembers(params.id)
  const kc = getKeycloakAdminClient(locals.tenant)
  const enriched = await Promise.all(
    members.map(async (m) => {
      try {
        const u = await kc.getUser(m.user_keycloak_id)
        const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username
        return { ...m, email: mayReadEmail ? u.email : null, name }
      } catch {
        return { ...m, email: null, name: null }
      }
    })
  )
  return json({ success: true, data: enriched })
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  if (!(await getOrgUnit(params.id))) {
    return json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const parsed = addMemberSchema.safeParse(await request.json())
  if (!parsed.success) {
    return json({ success: false, error: parsed.error.issues.map((i) => i.message).join(', ') }, { status: 400 })
  }
  const { userKeycloakId, membershipType, termStart, termEnd } = parsed.data
  const report = await addMember(params.id, userKeycloakId, membershipType, termStart, termEnd)
  await writeAuditEntry({
    userId: user.id, field: 'org_unit.member.add',
    oldValue: null, newValue: `${params.id}:${userKeycloakId}:${report.overall}`
  })
  // K2#7: the member row exists, but a subsystem (Keycloak group, Matrix room, ...)
  // failed to follow. That is not a success; answer 207 success:false like the
  // committee DELETE does, with the report so the UI can say what is missing.
  if (report.overall !== 'ok') {
    return json(
      {
        success: false,
        error: 'Mitglied angelegt, aber die Bereitstellung in einzelnen Diensten ist fehlgeschlagen. Bitte die Bereitstellung des Gremiums erneut anstoßen.',
        data: { report },
      },
      { status: 207 },
    )
  }
  return json({ success: true, data: { report } }, { status: 201 })
}
