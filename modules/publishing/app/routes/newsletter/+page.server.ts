import { redirect } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import { resolveNewsletterBackendForPage } from '$lib/server/newsletter/backend/resolve'

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user || !hasRole(locals.user.roles, Role.Finance)) {
    redirect(302, '/auth/login?error=forbidden')
  }
  const backend = resolveNewsletterBackendForPage()
  const rows = await backend.listNewsletters()
  // v5 Task 4.1 — enrich each issue with its resolved recipient reach so the
  // card grid can show the count without an extra round-trip. open_rate is not
  // tracked yet (no Mailman 3 webhook wired); the card omits it gracefully when
  // null rather than inventing a figure.
  const newsletters = await Promise.all(rows.map(async (n) => ({
    ...n,
    recipientCount: await backend.countNewsletterRecipients(n.id),
    open_rate: null as number | null,
  })))
  return {
    newsletters,
    lists: await backend.listMailingLists(),
    subscriberCount: await backend.countSubscribers(),
  }
}
