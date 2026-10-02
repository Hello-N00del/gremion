// GET / PATCH / DELETE /api/calendar/events/[id] — Stream B1.
//
// Single-event read/update/delete. Non-manual sources (helios, holiday) are
// read-only from the UI's perspective: PATCH and DELETE reject them with 403.
// Minutes-sourced events are still user-created and remain editable.

import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { resolveCalendarBackendOr503 } from '$lib/server/calendar/backend/resolve'
import type { DbRecurrence } from '$lib/server/calendar/backend'

const recurrenceSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(99).default(1),
  until: z.string().datetime().nullable().default(null),
  count: z.number().int().min(1).max(999).nullable().default(null),
  byday: z.array(z.string().max(4)).nullable().default(null),
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
    startAt: d.startAt ? new Date(d.startAt) : undefined,
    endAt: d.endAt ? new Date(d.endAt) : undefined,
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

  await backend.deleteEvent(params.id!)
  return json({ success: true, data: null })
}
