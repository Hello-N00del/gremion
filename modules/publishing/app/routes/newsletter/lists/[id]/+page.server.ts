import { redirect, error } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import { resolveNewsletterBackendForPage } from '$lib/server/newsletter/backend/resolve'

export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user || !hasRole(locals.user.roles, Role.Finance)) {
    redirect(302, '/auth/login?error=forbidden')
  }
  const id = parseInt(params.id, 10)
  if (isNaN(id)) error(400, 'Invalid id')
  const backend = resolveNewsletterBackendForPage()
  const lists = await backend.listMailingLists()
  const list = lists.find((l) => l.id === id)
  if (!list) error(404, 'List not found')
  return { list, members: await backend.listMembers(id) }
}
