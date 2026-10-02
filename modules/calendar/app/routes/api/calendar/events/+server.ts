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

const recurrenceSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(99).default(1),
  until: z.string().datetime().nullable().default(null),
  count: z.number().int().min(1).max(999).nullable().default(null),
  byday: z.array(z.string().max(4)).nullable().default(null),
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
  const filter: ListEventsFilter = {}
  const now = new Date()
  filter.from = p.get('from')
    ? new Date(p.get('from')!)
    : new Date(now.getFullYear(), now.getMonth(), 1)
  filter.to = p.get('to')
    ? new Date(p.get('to')!)
    : new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59)
  if (p.get('committeeId')) filter.committeeId = p.get('committeeId')!
  if (p.get('eventTypeId')) filter.eventTypeId = p.get('eventTypeId')!

  const events = await backend.listEvents(filter)
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
