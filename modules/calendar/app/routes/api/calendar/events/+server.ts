// GET / POST /api/calendar/events — Stream B1.
//
// Event list and create. All reads come from stura Postgres (the source of
// truth). CalDAV is push-only; creating an event also enqueues a CalDAV push.
//
// GET supports query filters:
//   from, to              ISO strings — bounds the window (default = current month)
//   committeeId           uuid — only events tagged to this committee
//   eventTypeId           uuid — only this type
//
// Response event payload includes server-computed { primary, secondary } colour
// and a `readOnly` flag (true for source='helios' or 'holiday').

import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { resolveCalendarBackendOr503 } from '$lib/server/calendar/backend/resolve'
import type { ListEventsFilter, DbRecurrence } from '$lib/server/calendar/backend'
import { canPublishEvent, forbiddenCommitteeTags, loadEventAuthzContext } from '$lib/server/calendar/event-authz'
import { expandRecurringEvents } from '$lib/server/calendar/recurrence-expand'

const recurrenceSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(99).default(1),
  until: z.string().datetime().nullable().default(null),
  count: z.number().int().min(1).max(999).nullable().default(null),
  // F1-FIX-08 (K4#21): RFC 5545 weekdays only (no CRLF into the ICS body).
  byday: z.array(z.string().regex(/^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/)).nullable().default(null),
  exceptions: z.array(z.string().datetime()).nullable().default(null),
})

const createSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).nullable().default(null),
  location: z.string().max(500).nullable().default(null),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  allDay: z.boolean().default(false),
  isPublic: z.boolean().default(false),
  eventTypeId: z.string().uuid().nullable().default(null),
  committeeIds: z.array(z.string().uuid()).default([]),
  recurrence: recurrenceSchema.nullable().default(null),
})

export const GET: RequestHandler = async ({ url, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Guest)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const resolved = resolveCalendarBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved

  const p = url.searchParams
  const now = new Date()
  const from = p.get('from')
    ? new Date(p.get('from')!)
    : new Date(now.getFullYear(), now.getMonth(), 1)
  const to = p.get('to')
    ? new Date(p.get('to')!)
    : new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return json({ success: false, error: 'Invalid from/to' }, { status: 400 })
  }
  const filter: ListEventsFilter = { from, to }
  if (p.get('committeeId')) filter.committeeId = p.get('committeeId')!
  if (p.get('eventTypeId')) filter.eventTypeId = p.get('eventTypeId')!

  // F1-FIX-08 (S1c#12): recurring masters that started before the window are
  // expanded into the window's occurrences instead of vanishing.
  const events = expandRecurringEvents(await backend.listEvents(filter), from, to)
  return json({ success: true, data: events })
}

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

  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return json(
      { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') },
      { status: 400 },
    )
  }

  const d = parsed.data

  // F1-FIX-08 (S3#29): a non-admin may only tag committees they belong to and
  // may only publish (isPublic=true) for one of those committees.
  const authz = await loadEventAuthzContext(user)
  if (forbiddenCommitteeTags(authz, d.committeeIds).length > 0) {
    return json({ success: false, error: 'Forbidden: not a member of that committee' }, { status: 403 })
  }
  if (d.isPublic && !canPublishEvent(authz, d.committeeIds)) {
    return json({ success: false, error: 'Forbidden: publishing needs committee membership' }, { status: 403 })
  }

  const recurrence: DbRecurrence | null = d.recurrence
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

  const created = await backend.createEvent({
    title: d.title,
    description: d.description,
    location: d.location,
    startAt: new Date(d.startAt),
    endAt: new Date(d.endAt),
    allDay: d.allDay,
    isPublic: d.isPublic,
    eventTypeId: d.eventTypeId,
    isMultiCommittee: d.committeeIds.length > 1,
    createdBy: user.id,
    source: 'manual',
    externalId: null,
    committeeIds: d.committeeIds,
    recurrence,
  })

  return json({ success: true, data: created }, { status: 201 })
}
