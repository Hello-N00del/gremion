// DELETE /api/content/lists/[id]/members/[memberId] — remove a member from a
// content mailing list. Gated by `content.author`.
import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireContentAuthor } from '$lib/server/content/route-auth'
import { resolveContentBackendOr503 } from '$lib/server/content/backend/resolve'

export const DELETE: RequestHandler = async (event) => {
  requireContentAuthor(event.locals.user)
  const resolved = resolveContentBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  await backend.removeListMember(event.params.id, event.params.memberId)
  return json({ ok: true })
}
