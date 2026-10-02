import type { PageServerLoad } from './$types'
import type { SessionUser } from '$lib/auth'
import { listOrgUnits, getOrgUnitIdsForUser } from '$lib/server/governance/org-units-db'
import { resolveCalendarBackendForPage } from '$lib/server/calendar/backend/resolve'
import { deriveAbbr, deriveHue } from '$lib/governance/committee-color'
import { canListOrgUnit } from '$lib/server/governance/visibility'

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
// to empty when no user is present. Since F1-FIX-04 r3 (D-3) a viewer gets
// chips only for the units they may know of (canListOrgUnit), so no session
// gets no chips.
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
  // F1-FIX-04 round 3 (operator decision D-3): a committee_only unit gets a
  // chip only for its members and CouncilAdmins. A failed membership lookup
  // reads as "member of nothing", so it fails closed.
  const listed = committees.filter((c) => canListOrgUnit(user, c, myIdSet.has(c.id)))
  const calendarCommittees: CalendarCommittee[] = listed.map((c) => ({
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
