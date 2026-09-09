import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import {
  createAssignment, getActiveAssignment, archiveAssignment,
  scheduleNotifications
} from '$lib/server/governance/governance-db'
import { listOrgUnitMembers } from '$lib/server/governance/org-units-db'

const assignSchema = z.object({
  userKeycloakId: z.string().min(1),
  startDate: z.string().date(),
  endDate: z.string().date(),
  heliosElectionId: z.string().nullable().default(null)
})

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const body = await request.json()
  const parsed = assignSchema.safeParse(body)
  if (!parsed.success) {
    return json(
      { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') },
      { status: 400 }
    )
  }

  const existing = await getActiveAssignment(params.roleId)
  if (existing) {
    await archiveAssignment(existing, 'removed')
  }

  const assignment = await createAssignment({
    roleId: params.roleId,
    userKeycloakId: parsed.data.userKeycloakId,
    startDate: new Date(parsed.data.startDate),
    endDate: new Date(parsed.data.endDate),
    assignedByKeycloakId: user.id,
    heliosElectionId: parsed.data.heliosElectionId
  })

  // Per design decision D4: roles and membership are independent.
  // Assigning a role no longer silently joins the user to the Keycloak group.
  // Membership is managed explicitly through the member panel / orchestrator.

  const members = await listOrgUnitMembers(params.id)
  const memberIds = members.map((m) => m.user_keycloak_id)
  await scheduleNotifications(assignment, [parsed.data.userKeycloakId, ...memberIds])

  return json({ success: true, data: assignment }, { status: 201 })
}
