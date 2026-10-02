// POST /api/calendar/automations/helios — Stream B1 shared endpoint.
//
// Consumer: Stream B2 (Helios-Voting UI). Called server-to-server when an
// election is created or its schedule changes. Creates up to four read-only
// calendar events tagged 'helios' with the election UUID as external_id.
//
// Request body (JSON):
// {
//   "electionId": "uuid",              // required — used as external_id for idempotency
//   "name": "string",                   // required — prefixed onto event titles
//   "committeeId": "uuid" | null,       // optional — single-committee tagging
//   "nominationDeadline": ISO | null,   // optional
//   "votingStartsAt":      ISO | null,  // optional
//   "votingEndsAt":        ISO | null,  // optional
//   "resultsAt":           ISO | null   // optional
// }
//
// Response: { success: true, data: { created: number } }
//
// Idempotent: re-POSTing for the same electionId first deletes any previous
// events for that election, so B2 can safely call on both create AND update.
//
// Auth: caller must be authenticated (Member+). In practice invoked via
// internal fetch from the elections route using the logged-in user's session.

import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { createHeliosCalendarEvents } from '$lib/server/calendar/calendar-automations'

const bodySchema = z.object({
  electionId: z.string().uuid(),
  name: z.string().min(1).max(300),
  committeeId: z.string().uuid().nullable().default(null),
  nominationDeadline: z.string().datetime().nullable().default(null),
  votingStartsAt: z.string().datetime().nullable().default(null),
  votingEndsAt: z.string().datetime().nullable().default(null),
  resultsAt: z.string().datetime().nullable().default(null),
})

export const POST: RequestHandler = async ({ request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return json(
      { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') },
      { status: 400 },
    )
  }

  const d = parsed.data
  const toDate = (s: string | null) => (s ? new Date(s) : null)

  await createHeliosCalendarEvents({
    electionId: d.electionId,
    name: d.name,
    committeeId: d.committeeId,
    nominationDeadline: toDate(d.nominationDeadline),
    votingStartsAt: toDate(d.votingStartsAt),
    votingEndsAt: toDate(d.votingEndsAt),
    resultsAt: toDate(d.resultsAt),
    createdBy: user.id,
  })

  const created = [
    d.nominationDeadline,
    d.votingStartsAt,
    d.votingEndsAt,
    d.resultsAt,
  ].filter((v) => v !== null).length

  return json({ success: true, data: { created } }, { status: 200 })
}
