import { error } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { createPollsClient } from '$lib/server/polls/polls-client'

export const load: PageServerLoad = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) {
    error(403, 'Forbidden')
  }

  const pollId = Number(params.id)
  if (!Number.isInteger(pollId) || pollId < 1) {
    error(400, 'Ungültige Umfrage-ID')
  }

  // Per-user client so vote state (currentUserStatus) is the viewer's, not the
  // shared NC admin's (#411).
  const client = createPollsClient({ oidcBearer: locals.accessToken ?? undefined })
  try {
    const poll = await client.getPollWithOptions(pollId)
    return { poll }
  } catch (err) {
    // The Polls client throws `Nextcloud Polls <path> → <status>` on a non-2xx
    // response. Map a not-found poll (deleted, or an id that never existed) to a
    // clean SvelteKit 404; rethrow everything else (auth, 5xx, network) so the
    // error boundary and logs still see the real failure.
    if (err instanceof Error && /→\s*404\b/.test(err.message)) {
      error(404, 'Umfrage nicht gefunden')
    }
    throw err
  }
}
