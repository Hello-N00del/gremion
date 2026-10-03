// Invite page load — Stream B1.
// Invite URLs reuse the event's stura DB UUID as the path param (still
// called `uid` to keep existing links stable). The iCal payload is rendered
// on-the-fly from the DB row for download.

import { error } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'
import type { SessionUser } from '$lib/auth'
import { resolveCalendarBackendForPage } from '$lib/server/calendar/backend/resolve'
import { buildIcs } from '$lib/server/calendar/caldav-client'

export const load: PageServerLoad = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')

  const backend = resolveCalendarBackendForPage()
  const ev = await backend.getEvent(params.uid)
  if (!ev) throw error(404, 'Termin nicht gefunden')

  const icsData = buildIcs({
    uid: ev.caldavUid ?? ev.id,
    summary: ev.title,
    description: ev.description,
    location: ev.location,
    dtstart: ev.startAt,
    dtend: ev.endAt,
    allDay: ev.allDay,
    recurrence: ev.recurrence,
  })

  return {
    event: {
      uid: ev.id,
      summary: ev.title,
      description: ev.description,
      location: ev.location,
      dtstart: ev.startAt.toISOString(),
      dtend: ev.endAt.toISOString(),
      allDay: ev.allDay,
      icsData,
    },
  }
}
