import { error, json } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import { getActionItem, getProtocol, updateActionItem } from '$lib/server/protocols/protocol-db'
import { requireUuidParams } from '$lib/server/protocols/route-ids'
import { optionalAssignee, optionalDueDate, requireTaskText } from '$lib/server/protocols/action-item-input'
import { isMemberOf } from '$lib/server/governance/org-units-db'

function requireAdmin(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  if (!hasRole(user.roles, Role.CouncilAdmin)) throw error(403, 'Nur Admins')
  return user
}

export async function PATCH(event: RequestEvent) {
  requireAdmin(event)
  requireUuidParams(event, 'id', 'itemId')
  const protocol = await getProtocol(event.params.id!)
  if (!protocol) throw error(404, 'Protokoll nicht gefunden')
  // The item must belong to the protocol in the URL (the committee and status checks below judge that one).
  const item = await getActionItem(event.params.itemId!)
  if (!item || item.protocol_id !== protocol.id) throw error(404, 'Aufgabe nicht gefunden')

  const body = await event.request.json()
  // A field that was not sent stays as it is, one sent empty (null) is cleared;
  // a title that was sent must not be blank.
  const text = body.text === undefined ? undefined : requireTaskText(body.text)
  const dueDate = optionalDueDate(body.dueDate)
  const assigneeKeycloakId = optionalAssignee(body.assigneeKeycloakId)
  // Published minutes keep their content; ticking a task off or on is follow-up work and stays possible.
  if (protocol.status === 'published' && (text !== undefined || dueDate !== undefined || assigneeKeycloakId !== undefined)) {
    throw error(403, 'Nicht bearbeitbar')
  }
  // Only a newly chosen person has to be a member: a task keeps its stored assignee
  // when its title is edited after that person left the body.
  if (
    assigneeKeycloakId &&
    assigneeKeycloakId !== item.assignee_keycloak_id &&
    !(await isMemberOf(protocol.committee_id, assigneeKeycloakId))
  ) {
    throw error(400, 'Die zuständige Person ist kein Mitglied des Gremiums.')
  }
  const actionItem = await updateActionItem(item.id, {
    text,
    assigneeKeycloakId,
    dueDate,
    completed: body.completed,
  })
  return json({ actionItem })
}
