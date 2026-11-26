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
  if (protocol.status === 'published') throw error(403, 'Nicht bearbeitbar')
  // The item must belong to the protocol in the URL (the committee and status checks above judge that one).
  const item = await getActionItem(event.params.itemId!)
  if (!item || item.protocol_id !== protocol.id) throw error(404, 'Aufgabe nicht gefunden')

  const body = await event.request.json()
  // Fields that were not sent stay as they are; a title that was sent must not be blank.
  const text = body.text === undefined ? undefined : requireTaskText(body.text)
  const dueDate = optionalDueDate(body.dueDate)
  const assigneeKeycloakId = optionalAssignee(body.assigneeKeycloakId)
  if (assigneeKeycloakId && !(await isMemberOf(protocol.committee_id, assigneeKeycloakId))) {
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
