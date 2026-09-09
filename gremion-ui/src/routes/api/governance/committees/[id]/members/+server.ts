// src/routes/api/governance/committees/[id]/members/+server.ts
import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { listOrgUnitMembers, getOrgUnit } from '$lib/server/governance/org-units-db'
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
  const members = await listOrgUnitMembers(params.id)
  const kc = getKeycloakAdminClient(locals.tenant)
  const enriched = await Promise.all(
    members.map(async (m) => {
      try {
        const u = await kc.getUser(m.user_keycloak_id)
        return { ...m, email: u.email, name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username }
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
  return json({ success: true, data: { report } }, { status: 201 })
}
