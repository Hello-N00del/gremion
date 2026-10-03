// POST /api/calendar/automations/minutes — Stream B1 shared endpoint.
//
// Consumer: Stream B4 (Meeting Minutes). Called after minutes are saved to
// extract candidate calendar events from the text. Does NOT auto-commit —
// returns candidates for the UI to confirm. Use the /confirm sibling endpoint
// to actually commit accepted candidates.
//
// Request body (JSON):
// {
//   "text": "string"      // required — the full minutes body
// }
//
// Response:
// {
//   "success": true,
//   "data": {
//     "candidates": [
//       {
//         "title":    "string",
//         "date":     ISO string,
//         "location": "string" | null,
//         "source":   "template" | "body"
//       },
//       ...
//     ]
//   }
// }
//
// Extraction rules (see calendar-automations.ts):
//  • Structured `Nächstes Treffen:` template fields are always kept.
//  • Free-text German numeric dates (DD.MM.YYYY) are scanned as fallback.
//  • Body matches within 5 min of a template match are deduped.

import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { extractEventsFromMinutes } from '$lib/server/calendar/calendar-automations'
import { isInternalBearerRequest } from '$lib/server/internal-fetch'

const bodySchema = z.object({
  text: z.string().min(1).max(500_000),
})

export const POST: RequestHandler = async ({ request, locals }) => {
  // G-075: accept either an authenticated session (the existing
  // user-initiated path, e.g. the minutes admin UI calling this directly)
  // OR a trusted internal Bearer header from `internalFetch` (the
  // publish-protocol B1 trigger). The Bearer path short-circuits the role
  // check because the caller has already vetted the user — they're a
  // trusted in-process producer holding the shared secret.
  if (!isInternalBearerRequest(request)) {
    const session = await locals.auth()
    const user = session?.user as SessionUser | undefined
    if (!user || !hasRole(user.roles, Role.Member)) {
      return json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
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

  const candidates = extractEventsFromMinutes(parsed.data.text).map((c) => ({
    title: c.title,
    date: c.date.toISOString(),
    location: c.location,
    source: c.source,
  }))

  return json({ success: true, data: { candidates } }, { status: 200 })
}
