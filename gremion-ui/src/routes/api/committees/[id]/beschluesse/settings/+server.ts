import { error, json } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import { upsertBeschlussregisterSettings } from '$lib/server/protocols/protocol-db'

function requireAuth(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  return user
}

export async function PATCH(event: RequestEvent) {
  const user = requireAuth(event)
  if (!hasRole(user.roles, Role.CouncilAdmin)) throw error(403, 'Nur Admins können Einstellungen ändern')
  const body = await event.request.json()
  const settings = await upsertBeschlussregisterSettings(event.params.id!, {
    include_protocols: body.include_protocols,
    include_polls: body.include_polls,
    include_elections: body.include_elections,
  })
  return json({ settings })
}
