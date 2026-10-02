// POST /api/calendar/automations/minutes/confirm — Stream B1.
//
// Companion to /api/calendar/automations/minutes: commits the subset of
// extracted candidates the user accepted in the confirmation UI. Events are
// tagged with source='minutes' and the optional `minutesId` as external_id
// (so a later re-run on the same minutes is idempotent).
//
// Request body:
// {
//   "minutesId": "string" | null,     // optional — used as external_id
//   "committeeId": "uuid" | null,     // optional — tag all events to this committee
//   "events": [
//     {
//       "title":    "string",
//       "startAt":  ISO string,
//       "endAt":    ISO string | null,  // defaults to +1h
//       "location": "string" | null,
//       "allDay":   boolean (optional, default false)
//     },
//     ...
//   ]
// }
//
// Response: { success: true, data: { created: number, eventIds: string[] } }

import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { resolveCalendarBackendOr503 } from '$lib/server/calendar/backend/resolve'

const eventSchema = z.object({
  title: z.string().min(1).max(500),
  startAt: z.string().datetime(),
  endAt: z.string().datetime().nullable().default(null),
  location: z.string().max(500).nullable().default(null),
  allDay: z.boolean().default(false),
})

const bodySchema = z.object({
  minutesId: z.string().max(200).nullable().default(null),
  committeeId: z.string().uuid().nullable().default(null),
  events: z.array(eventSchema).min(1).max(50),
})

export const POST: RequestHandler = async ({ request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const resolved = resolveCalendarBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved

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

  const { minutesId, committeeId, events } = parsed.data

  // Idempotent: if this is a re-run with a minutesId, clear previous events
  // tagged with that id so the new set fully replaces them.
  if (minutesId) {
    await backend.deleteEventsByExternalId('minutes', minutesId)
  }

  const types = await backend.listEventTypes()
  const meetingTypeId = types.find((t) => t.name === 'Treffen')?.id ?? null
  const committeeIds = committeeId ? [committeeId] : []

  const eventIds: string[] = []
  for (const ev of events) {
    const startAt = new Date(ev.startAt)
    const endAt = ev.endAt
      ? new Date(ev.endAt)
      : new Date(startAt.getTime() + 60 * 60 * 1000)
    const created = await backend.createEvent({
      title: ev.title,
      description: null,
      location: ev.location,
      startAt,
      endAt,
      allDay: ev.allDay,
      eventTypeId: meetingTypeId,
      isMultiCommittee: false,
      createdBy: user.id,
      source: 'minutes',
      externalId: minutesId,
      committeeIds,
      recurrence: null,
    })
    eventIds.push(created.id)
  }

  return json(
    { success: true, data: { created: eventIds.length, eventIds } },
    { status: 201 },
  )
}
