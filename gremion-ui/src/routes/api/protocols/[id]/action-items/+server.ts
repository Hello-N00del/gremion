import { error, json } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import { getProtocol, addActionItem } from '$lib/server/protocols/protocol-db'

function requireAdmin(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  if (!hasRole(user.roles, Role.CouncilAdmin)) throw error(403, 'Nur Admins')
  return user
}

export async function POST(event: RequestEvent) {
  requireAdmin(event)
  const protocol = await getProtocol(event.params.id!)
  if (!protocol || protocol.status === 'published') throw error(403, 'Nicht bearbeitbar')
  const body = await event.request.json()
  const actionItem = await addActionItem(protocol.id, {
    text: body.text ?? '',
    assigneeKeycloakId: body.assigneeKeycloakId,
    dueDate: body.dueDate,
  })
  return json({ actionItem }, { status: 201 })
}
