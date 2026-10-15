import { redirect } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import { resolveNewsletterBackendForPage } from '$lib/server/newsletter/backend/resolve'

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user || !hasRole(locals.user.roles, Role.Finance)) {
    redirect(302, '/auth/login?error=forbidden')
  }
  return { lists: await resolveNewsletterBackendForPage().listMailingLists() }
}
