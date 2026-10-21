import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import { resolveNewsletterBackendOr503 } from '$lib/server/newsletter/backend/resolve'

export const DELETE: RequestHandler = async ({ params, locals }) => {
  if (!locals.user || !hasRole(locals.user.roles, Role.Finance)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const listId = parseInt(params.id, 10)
  const memberId = parseInt(params.memberId, 10)
  if (isNaN(listId) || isNaN(memberId))
    return json({ success: false, error: 'Invalid id' }, { status: 400 })
  const backend = resolveNewsletterBackendOr503()
  if (backend instanceof Response) return backend
  // Pass the list-scoped pair: SQLite deletes by memberId, the service client
  // builds the real /lists/:listId/members/:memberId URL (F-IMP — no placeholder).
  await backend.deleteMember(listId, memberId)
  return json({ success: true, data: null })
}
