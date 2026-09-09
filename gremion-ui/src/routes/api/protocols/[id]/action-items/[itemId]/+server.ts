import { error, json } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import { updateActionItem } from '$lib/server/protocols/protocol-db'

function requireAdmin(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  if (!hasRole(user.roles, Role.CouncilAdmin)) throw error(403, 'Nur Admins')
  return user
}

export async function PATCH(event: RequestEvent) {
  requireAdmin(event)
  const body = await event.request.json()
  const actionItem = await updateActionItem(event.params.itemId!, {
    text: body.text,
    assigneeKeycloakId: body.assigneeKeycloakId,
    dueDate: body.dueDate,
    completed: body.completed,
  })
  return json({ actionItem })
}
