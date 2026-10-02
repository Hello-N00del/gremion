// POST /api/calendar/automations/holidays/sync — Stream B1.
//
// Manual trigger for the German public holiday import. Only IT-admin can
// invoke. Fetches from the OpenHolidays API for the configured Bundesland
// (calendar.german_state in config.json) and upserts into calendar_events
// with source='holiday'. Idempotent — re-running the same year does not
// duplicate events.
//
// Request body:
// {
//   "year": number (optional, defaults to current year)
// }
//
// Response: { success: true, data: { year: number, subdivisionCode: string } }

import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { syncPublicHolidays } from '$lib/server/calendar/calendar-automations'
import { readConfig } from '$lib/server/config'

const bodySchema = z.object({
  year: z.number().int().min(2000).max(2100).optional(),
})

export const POST: RequestHandler = async ({ request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.ITAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  let body: unknown = {}
  try {
    const txt = await request.text()
    body = txt ? JSON.parse(txt) : {}
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

  const year = parsed.data.year ?? new Date().getFullYear()
  const cfg = readConfig()
  const subdivisionCode = cfg.calendar?.german_state ?? 'DE'

  try {
    await syncPublicHolidays({
      countryCode: 'DE',
      subdivisionCode,
      year,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return json({ success: false, error: msg }, { status: 502 })
  }

  return json({ success: true, data: { year, subdivisionCode } })
}
