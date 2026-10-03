// GET / PATCH /api/calendar/settings/committees/[id] — Stream B1.
// Read and update per-committee calendar colour (used as the "primary" tone
// in the dual-tone event colouring).

import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { resolveCalendarBackendOr503 } from '$lib/server/calendar/backend/resolve'

const bodySchema = z.object({
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a hex code like #rrggbb'),
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
  const settings = await backend.getCommitteeCalendarSettings(params.id!)
  return json({ success: true, data: settings })
}

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
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

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return json(
      { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') },
      { status: 400 },
    )
  }

  const updated = await backend.upsertCommitteeCalendarSettings(params.id!, parsed.data.color)
  return json({ success: true, data: updated })
}
