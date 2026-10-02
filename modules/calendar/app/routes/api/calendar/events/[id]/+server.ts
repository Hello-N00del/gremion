// GET / PATCH / DELETE /api/calendar/events/[id] — Stream B1.
//
// Single-event read/update/delete. Non-manual sources (helios, holiday) are
// read-only from the UI's perspective: PATCH and DELETE reject them with 403.
// Minutes-sourced events are still user-created and remain editable.
// F1-FIX-08 (S3#29): PATCH/DELETE also require the creator, a member of one of
// the event's committees, or CouncilAdmin (see lib/server/calendar/event-authz).

import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { resolveCalendarBackendOr503 } from '$lib/server/calendar/backend/resolve'
import type { DbEvent, DbRecurrence } from '$lib/server/calendar/backend'
import { expandRecurringEvents } from '$lib/server/calendar/recurrence-expand'
import {
  canManageEvent,
  canPublishEvent,
  forbiddenCommitteeTags,
  loadEventAuthzContext,
} from '$lib/server/calendar/event-authz'

const recurrenceSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(99).default(1),
  until: z.string().datetime().nullable().default(null),
  count: z.number().int().min(1).max(999).nullable().default(null),
  // F1-FIX-08 (K4#21): RFC 5545 weekdays only (no CRLF into the ICS body).
  byday: z.array(z.string().regex(/^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/)).nullable().default(null),
  exceptions: z.array(z.string().datetime()).nullable().default(null),
})

const updateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  startAt: z.string().datetime().optional(),
  endAt: z.string().datetime().optional(),
  allDay: z.boolean().optional(),
  isPublic: z.boolean().optional(),
  eventTypeId: z.string().uuid().nullable().optional(),
  committeeIds: z.array(z.string().uuid()).optional(),
  recurrence: recurrenceSchema.nullable().optional(),
})

export const GET: RequestHandler = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Guest)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const resolved = resolveCalendarBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  const ev = await backend.getEvent(params.id!)
  if (!ev) return json({ success: false, error: 'Not found' }, { status: 404 })
  return json({ success: true, data: ev })
}

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const resolved = resolveCalendarBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved

  const existing = await backend.getEvent(params.id!)
  if (!existing) return json({ success: false, error: 'Not found' }, { status: 404 })
  if (existing.readOnly) {
    return json(
      { success: false, error: 'Event is read-only (automation source)' },
      { status: 403 },
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return json(
      { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') },
      { status: 400 },
    )
  }

  const d = parsed.data

  // S3#29: creator, committee member or CouncilAdmin only; publishing and
  // committee tagging need committee membership or CouncilAdmin.
  const authz = await loadEventAuthzContext(user)
  if (!canManageEvent(authz, existing)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  if (d.committeeIds !== undefined && forbiddenCommitteeTags(authz, d.committeeIds, existing.committeeIds).length > 0) {
    return json({ success: false, error: 'Forbidden: not a member of that committee' }, { status: 403 })
  }
  if (d.isPublic === true && !canPublishEvent(authz, d.committeeIds ?? existing.committeeIds)) {
    return json({ success: false, error: 'Forbidden: publishing needs committee membership' }, { status: 403 })
  }

  // F1-FIX-08 round 2: GET lists the expanded occurrences of a series, all
  // with the series id, and the mobile client PATCHes the event it listed,
  // times included. Times that name an occurrence of the series are therefore
  // not a move: the other fields apply to the series. Any other time change on
  // a series needs an explicit `recurrence` (a series-aware edit); without one
  // it would silently move DTSTART and drop every earlier occurrence.
  let startAt = d.startAt ? new Date(d.startAt) : undefined
  let endAt = d.endAt ? new Date(d.endAt) : undefined
  if (existing.recurrence && d.recurrence === undefined) {
    const seriesStart = new Date(existing.startAt).getTime()
    const seriesEnd = new Date(existing.endAt).getTime()
    const moves =
      (startAt !== undefined && startAt.getTime() !== seriesStart) ||
      (endAt !== undefined && endAt.getTime() !== seriesEnd)
    if (moves) {
      if (!startAt || !isOccurrenceOf(existing, startAt, endAt)) {
        return json(
          {
            success: false,
            error: 'Einzeltermine einer Serie lassen sich nicht verschieben; zum Verschieben der Serie recurrence mitsenden',
          },
          { status: 409 },
        )
      }
      startAt = undefined
      endAt = undefined
    }
  }

  let recurrence: DbRecurrence | null | undefined = undefined
  if (d.recurrence !== undefined) {
    recurrence = d.recurrence
      ? {
          frequency: d.recurrence.frequency,
          interval: d.recurrence.interval,
          until: d.recurrence.until ? new Date(d.recurrence.until) : null,
          count: d.recurrence.count,
          byday: d.recurrence.byday,
          exceptions: d.recurrence.exceptions
            ? d.recurrence.exceptions.map((s) => new Date(s))
            : null,
        }
      : null
  }

  const updated = await backend.updateEvent(params.id!, {
    title: d.title,
    description: d.description,
    location: d.location,
    startAt,
    endAt,
    allDay: d.allDay,
    isPublic: d.isPublic,
    eventTypeId: d.eventTypeId,
    isMultiCommittee:
      d.committeeIds !== undefined ? d.committeeIds.length > 1 : undefined,
    committeeIds: d.committeeIds,
    recurrence,
  })

  return json({ success: true, data: updated })
}

/** True when [startAt, endAt?] is exactly one occurrence of the series. */
function isOccurrenceOf(series: DbEvent, startAt: Date, endAt: Date | undefined): boolean {
  const t = startAt.getTime()
  return expandRecurringEvents([series], startAt, new Date(t + 1)).some(
    (o) => o.startAt.getTime() === t && (endAt === undefined || o.endAt.getTime() === endAt.getTime()),
  )
}

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const resolved = resolveCalendarBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved

  const existing = await backend.getEvent(params.id!)
  if (!existing) return json({ success: false, error: 'Not found' }, { status: 404 })
  if (existing.readOnly) {
    return json(
      { success: false, error: 'Event is read-only (automation source)' },
      { status: 403 },
    )
  }
  if (!canManageEvent(await loadEventAuthzContext(user), existing)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  await backend.deleteEvent(params.id!)
  return json({ success: true, data: null })
}
