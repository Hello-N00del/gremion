import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { createPollsClient } from '$lib/server/polls/polls-client'

/** Click-time fetch of a single poll's options for the /votes detail panel.
 *
 * Eager-loading every poll's options on /votes list render would multiply the
 * Nextcloud round-trips per page load (N+1). The list response carries enough
 * to render the row; this endpoint fills in the option counts only when the
 * user actually selects a poll. */
export const GET: RequestHandler = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) {
    error(403, 'Forbidden')
  }

  const id = Number(params.id)
  if (!Number.isFinite(id) || id <= 0) {
    error(400, 'Invalid poll id')
  }

  try {
    // Per-user client so option vote counts respect NC's per-user visibility
    // rules instead of the admin's view (#411).
    const client = createPollsClient({ oidcBearer: locals.accessToken ?? undefined })
    const poll = await client.getPollWithOptions(id)
    return json({
      options: (poll.options ?? []).map((o) => ({
        label: o.text,
        votes: o.votes.count,
      })),
    })
  } catch (e) {
    // Do not pass upstream error messages through — they may include internal
    // hostnames or credentials in connection-refused scenarios.
    console.error('[api/polls/[id]/options]', e)
    error(502, 'Umfragen-API nicht erreichbar')
  }
}
