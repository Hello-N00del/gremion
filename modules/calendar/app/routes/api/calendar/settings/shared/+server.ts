// GET / PATCH /api/calendar/settings/shared — Stream B1.
// Read and update the "multi-committee" shared colour used when an event is
// tagged to more than one committee. IT-admin only (lives in config.json).

import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { readConfig, writeConfig } from '$lib/server/config'

const bodySchema = z.object({
  sharedEventColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'sharedEventColor must be a hex code like #rrggbb')
    .optional(),
  germanState: z
    .string()
    .regex(/^DE(-[A-Z]{2})?$/, 'germanState must be DE or DE-XX')
    .optional(),
})

export const GET: RequestHandler = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Guest)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const cfg = readConfig()
  return json({
    success: true,
    data: {
      sharedEventColor: cfg.calendar?.shared_event_color ?? '#94a3b8',
      germanState: cfg.calendar?.german_state ?? 'DE',
    },
  })
}

export const PATCH: RequestHandler = async ({ request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.ITAdmin)) {
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

  const current = readConfig()
  const next = writeConfig({
    calendar: {
      shared_event_color:
        parsed.data.sharedEventColor ?? current.calendar?.shared_event_color ?? '#94a3b8',
      german_state:
        parsed.data.germanState ?? current.calendar?.german_state ?? 'DE',
    },
  })

  return json({
    success: true,
    data: {
      sharedEventColor: next.calendar?.shared_event_color ?? '#94a3b8',
      germanState: next.calendar?.german_state ?? 'DE',
    },
  })
}
