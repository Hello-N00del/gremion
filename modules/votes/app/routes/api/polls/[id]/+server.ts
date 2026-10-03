import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { createPollsClient } from '$lib/server/polls/polls-client'

const voteSchema = z.object({
  optionId: z.number().int().min(1),
})

export const GET: RequestHandler = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const id = Number(params.id)
  if (!Number.isInteger(id) || id < 1) {
    return json({ success: false, error: 'Invalid poll id' }, { status: 400 })
  }

  // Per-user client: NC must attribute currentUserStatus (hasVoted, lock
  // state) to the acting user, not the shared admin (#411).
  const client = createPollsClient({ oidcBearer: locals.accessToken ?? undefined })
  const poll = await client.getPollWithOptions(id)
  return json({
    success: true,
    data: {
      id: poll.id,
      title: poll.configuration.title,
      options: (poll.options ?? []).map((o) => ({ id: o.id, text: o.text, votes: 0 })),
      isExpired: poll.status.expired,
      hasVoted: (poll.currentUserStatus?.countVotes ?? 0) > 0,
    }
  })
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const id = Number(params.id)
  if (!Number.isInteger(id) || id < 1) {
    return json({ success: false, error: 'Invalid poll id' }, { status: 400 })
  }

  const body = await request.json()
  const parsed = voteSchema.safeParse(body)
  if (!parsed.success) {
    return json(
      { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') },
      { status: 400 },
    )
  }

  // Fail closed: without the acting user's OIDC bearer the vote would fall back
  // to the shared admin Basic-auth, which locks the poll for every other user
  // after the first vote (#411, item 3a). Never cast a vote as the admin.
  if (!locals.accessToken) {
    return json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  // Per-user client so the vote is cast AS the acting user (#411) — voting as
  // the shared admin locked the poll for every other user after the first vote.
  const client = createPollsClient({ oidcBearer: locals.accessToken })
  await client.vote(id, parsed.data.optionId)
  return json({ success: true, data: { voted: true } })
}
