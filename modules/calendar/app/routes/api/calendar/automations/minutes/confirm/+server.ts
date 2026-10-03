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
//   ],
//   "createdBy": "string"             // internal Bearer callers only (F1-FIX-03 / S3#5)
// }
//
// Callers: the internal Bearer (protocol publish) or a CouncilAdmin session.
//
// Response: { success: true, data: { created: number, eventIds: string[] } }

import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { resolveCalendarBackendOr503 } from '$lib/server/calendar/backend/resolve'
import { isInternalBearerRequest } from '$lib/server/internal-fetch'

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
  // Internal callers only (see below): the user the publish acted for.
  createdBy: z.string().min(1).max(200).optional(),
})

export const POST: RequestHandler = async ({ request, locals }) => {
  // F1-FIX-03 / S3#5: the protocol-publish flow commits the minutes' structured
  // "Nächstes Treffen" event through this endpoint via internalFetch (G-075),
  // so it accepts the trusted internal Bearer. The internal caller names the
  // acting user in `createdBy` (the publishing CouncilAdmin); a session
  // caller's `createdBy` is ignored and always their own id.
  //
  // Round 2 (house review HIGH): this endpoint deletes and replaces every
  // minutes event keyed on `minutesId`, and publish keys them on the protocol
  // id, so a session caller could wipe or overwrite the events a publish
  // created. The session path therefore requires CouncilAdmin, the role that
  // may publish a protocol (and the role the Helios sibling now requires).
  // No UI calls the session path today.
  const internal = isInternalBearerRequest(request)
  let actorId: string | null = null
  if (!internal) {
    const session = await locals.auth()
    const user = session?.user as SessionUser | undefined
    if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
      return json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
    actorId = user.id
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
  const createdBy = internal ? parsed.data.createdBy : actorId
  if (!createdBy) {
    return json({ success: false, error: 'createdBy is required for an internal caller' }, { status: 400 })
  }

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
      createdBy,
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
