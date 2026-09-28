// Content Engine — members of ONE content mailing list. Author-gated.
// ContentBackendPort has no single-list getter, so we resolve the list by id
// from the tenant's list set (cheap; tenants have a handful of lists) and load
// members.
import type { PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { requireContentAuthor } from '$lib/server/content/route-auth'
import { resolveContentBackendForPage } from '$lib/server/content/backend/resolve'

export const load: PageServerLoad = async ({ params, locals }) => {
  requireContentAuthor(locals.user)

  const backend = resolveContentBackendForPage()
  const lists = await backend.listMailingLists()
  const list = lists.find((l) => l.id === params.id)
  if (!list) throw error(404, 'Not found')

  const members = await backend.listMembers(list.id)
  return { list, members }
}
