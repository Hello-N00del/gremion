import { error, json } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import { getProtocol, addActionItem } from '$lib/server/protocols/protocol-db'
import { requireUuidParams } from '$lib/server/protocols/route-ids'
import { optionalAssignee, optionalDueDate, requireTaskText } from '$lib/server/protocols/action-item-input'
import { isMemberOf } from '$lib/server/governance/org-units-db'

function requireAdmin(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  if (!hasRole(user.roles, Role.CouncilAdmin)) throw error(403, 'Nur Admins')
  return user
}

export async function POST(event: RequestEvent) {
  requireAdmin(event)
  requireUuidParams(event, 'id')
  const protocol = await getProtocol(event.params.id!)
  if (!protocol || protocol.status === 'published') throw error(403, 'Nicht bearbeitbar')
  const body = await event.request.json()
  // A task is stored only with a title; the page opens a form first and sends this once it is filled.
  const text = requireTaskText(body.text)
  const dueDate = optionalDueDate(body.dueDate)
  const assigneeKeycloakId = optionalAssignee(body.assigneeKeycloakId)
  if (assigneeKeycloakId && !(await isMemberOf(protocol.committee_id, assigneeKeycloakId))) {
    throw error(400, 'Die zuständige Person ist kein Mitglied des Gremiums.')
  }
  const actionItem = await addActionItem(protocol.id, {
    text,
    assigneeKeycloakId: assigneeKeycloakId ?? undefined,
    dueDate: dueDate ?? undefined,
  })
  return json({ actionItem }, { status: 201 })
}
