import type { PageServerLoad } from './$types'
import type { SessionUser } from '$lib/auth'
import { listOrgUnits, getOrgUnitIdsForUser } from '$lib/server/governance/org-units-db'
import { resolveCalendarBackendForPage } from '$lib/server/calendar/backend/resolve'
import { deriveAbbr, deriveHue } from '$lib/governance/committee-color'

export interface CalendarCommittee {
  key: string
  label: string
  abbr: string
  hue: number
  mine: boolean
}

// The calendar page is intentionally accessible to all session users including
// guests (the Svelte component derives readonly mode from `Role.Guest`). The
// committee filter chips and the per-user "mine" flag both gracefully degrade
// to empty when no user is present — anonymous viewers see all committees but
// none marked as theirs.
export const load: PageServerLoad = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  const backend = resolveCalendarBackendForPage()

  // DB unavailability shouldn't blank the calendar — fall back to empty list.
  const [committees, myIds, eventTypes] = await Promise.all([
    listOrgUnits().catch(() => []),
    user ? getOrgUnitIdsForUser(user.id).catch(() => [] as readonly string[]) : Promise.resolve([] as readonly string[]),
    backend.listEventTypes().catch(() => []),
  ])

  const myIdSet = new Set(myIds)
  const calendarCommittees: CalendarCommittee[] = committees.map((c) => ({
    key: c.id,
    label: c.name,
    abbr: deriveAbbr(c.name),
    hue: deriveHue(c.id),
    mine: myIdSet.has(c.id),
  }))

  // Meeting-type legend: drive the on-screen swatches off the SAME stored
  // event_types.color the server uses for an event's body fill (secondary tone),
  // so the legend is literally identical to what the calendar renders — instead
  // of a hand-maintained colour map that can drift from the seeded types.
  const calendarEventTypes = eventTypes.map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color,
  }))

  return {
    user,
    committees: calendarCommittees,
    eventTypes: calendarEventTypes,
  }
}
