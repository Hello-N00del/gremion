// GET / POST /api/calendar/event-types — Stream B1.
// List all event types (system + custom); create a new custom type
// (council-admin+). System types are seeded by migration 003 and can only
// be created there.

import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { resolveCalendarBackendOr503 } from '$lib/server/calendar/backend/resolve'

const createSchema = z.object({
  name: z.string().min(1).max(100),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a hex code like #rrggbb'),
})

export const GET: RequestHandler = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Guest)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const resolved = resolveCalendarBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  const types = await backend.listEventTypes()
  return json({ success: true, data: types })
}

export const POST: RequestHandler = async ({ request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
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

  const created = await backend.createEventType(parsed.data)
  return json({ success: true, data: created }, { status: 201 })
}
