// DELETE /api/calendar/event-types/[id] — Stream B1.
// Delete a custom event type. System types cannot be deleted (enforced at
// the DB access layer).

import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { resolveCalendarBackendOr503 } from '$lib/server/calendar/backend/resolve'

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const resolved = resolveCalendarBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved

  try {
    await backend.deleteEventType(params.id!)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = msg.includes('system') ? 409 : msg.includes('not found') ? 404 : 500
    return json({ success: false, error: msg }, { status })
  }
  return json({ success: true, data: null })
}
