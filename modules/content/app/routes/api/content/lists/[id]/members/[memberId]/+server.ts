// DELETE /api/content/lists/[id]/members/[memberId] — remove a member from a
// content mailing list. Gated by `content.author`.
import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireContentAuthor } from '$lib/server/content/route-auth'
import { resolveContentBackendOr503 } from '$lib/server/content/backend/resolve'
import { requireContentId } from '$lib/server/content/ids'

export const DELETE: RequestHandler = async (event) => {
  requireContentAuthor(event.locals.user)
  // F1-FIX-07 H08: both ids are UUIDs; anything else is a 404 before the backend.
  const listId = requireContentId(event.params.id)
  const memberId = requireContentId(event.params.memberId)
  const resolved = resolveContentBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  await backend.removeListMember(listId, memberId)
  return json({ ok: true })
}
