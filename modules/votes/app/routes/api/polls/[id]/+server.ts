import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { createPollsClient, NextcloudPollsClient } from '$lib/server/polls/polls-client'
import { protocolReferencesPoll } from '$lib/server/protocols/protocol-db'
import { pollAccessStatus } from '$lib/server/polls/tenant-scope'

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
  let poll
  try {
    poll = await client.getPollWithOptions(id)
  } catch (e) {
    const status = pollAccessStatus(e)
    if (status) return json({ success: false, error: 'Poll unavailable' }, { status })
    throw e
  }
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
  try {
    await client.vote(id, parsed.data.optionId)
  } catch (e) {
    // 404 foreign/unknown poll or option, 409 closed / already voted, 401 no actor.
    const status = pollAccessStatus(e)
    if (status) return json({ success: false, error: 'Vote rejected' }, { status })
    throw e
  }
  return json({ success: true, data: { voted: true } })
}

// Closing and deleting are for the people who create polls (council admins and above); the check is here,
// on the server. Every poll is owned by the module's own Nextcloud account, so the write runs as that
// account (an acting member could not change it), after the tenant check inside the client.
async function managerOrRefusal(locals: App.Locals, rawId: string): Promise<{ id: number } | Response> {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const id = Number(rawId)
  if (!Number.isInteger(id) || id < 1) {
    return json({ success: false, error: 'Invalid poll id' }, { status: 400 })
  }
  return { id }
}

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  const who = await managerOrRefusal(locals, params.id)
  if (who instanceof Response) return who
  const body = (await request.json().catch(() => null)) as { closed?: unknown } | null
  if (body?.closed !== true) {
    return json({ success: false, error: 'Only closing a poll is supported' }, { status: 400 })
  }
  try {
    await NextcloudPollsClient.closePoll(who.id)
  } catch (e) {
    const status = pollAccessStatus(e)
    if (status) return json({ success: false, error: 'Poll unavailable' }, { status })
    throw e
  }
  return json({ success: true, data: { id: who.id, closed: true } })
}

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const who = await managerOrRefusal(locals, params.id)
  if (who instanceof Response) return who
  try {
    // The tenant check first: another tenant's poll is a plain 404 and its protocol links are never looked at.
    await NextcloudPollsClient.getPoll(who.id)
    // A poll a protocol points at (its approval poll) stays: deleting it would leave the protocol with a dead link.
    if (await protocolReferencesPoll(String(who.id))) {
      return json({ success: false, error: 'Poll is referenced by a protocol' }, { status: 409 })
    }
    await NextcloudPollsClient.deletePoll(who.id)
  } catch (e) {
    const status = pollAccessStatus(e)
    if (status) return json({ success: false, error: 'Poll unavailable' }, { status })
    throw e
  }
  return json({ success: true, data: { id: who.id, deleted: true } })
}
