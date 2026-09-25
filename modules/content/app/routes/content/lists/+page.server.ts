// Content Engine — mailing-list management (self-contained, content schema).
// Author-gated (content.author): only content authors curate the lists a post
// can fan out to. The list/create/delete mutations hit /api/content/lists.
import type { PageServerLoad } from './$types'
import { requireContentAuthor } from '$lib/server/content/route-auth'
import { resolveContentBackendForPage } from '$lib/server/content/backend/resolve'

export const load: PageServerLoad = async ({ locals }) => {
  requireContentAuthor(locals.user)
  const backend = resolveContentBackendForPage()
  return { lists: await backend.listMailingLists() }
}
