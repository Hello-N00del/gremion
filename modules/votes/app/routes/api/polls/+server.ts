import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { createPollsClient, NextcloudPollsClient } from '$lib/server/polls/polls-client'
import { parseJsonBody } from '$lib/server/parse-json-body'

const createPollSchema = z.object({
  title: z.string().min(1).max(200),
  type: z.enum(['textPoll', 'datePoll']).default('textPoll'),
  options: z.array(z.string().min(1)).min(2).max(20),
  anonymous: z.boolean().default(false),
  description: z.string().max(1000).optional(),
  expire: z.number().int().min(0).optional(),
})

export const GET: RequestHandler = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // Per-user client so each poll's currentUserStatus reflects the viewer, not
  // the shared NC admin (#411).
  const client = createPollsClient({ oidcBearer: locals.accessToken ?? undefined })
  const polls = await client.listPolls()
  return json({ success: true, data: polls })
}

export const POST: RequestHandler = async ({ request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const body = await parseJsonBody(request)
  const parsed = createPollSchema.safeParse(body)
  if (!parsed.success) {
    return json(
      { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') },
      { status: 400 },
    )
  }

  // Deliberately the admin singleton: polls stay owned by the NC admin so
  // system flows (protocols, elections, aggregators) can manage them (#411).
  const poll = await NextcloudPollsClient.createPoll(parsed.data)
  return json({ success: true, data: poll }, { status: 201 })
}
