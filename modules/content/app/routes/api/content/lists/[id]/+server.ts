// DELETE /api/content/lists/[id] — delete a content mailing list (cascades its
// members + post_recipient links). Gated by `content.author`.
import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireContentAuthor } from '$lib/server/content/route-auth'
import { resolveContentBackendOr503 } from '$lib/server/content/backend/resolve'

export const DELETE: RequestHandler = async (event) => {
  requireContentAuthor(event.locals.user)
  const resolved = resolveContentBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  await backend.deleteMailingList(event.params.id)
  return json({ ok: true })
}
