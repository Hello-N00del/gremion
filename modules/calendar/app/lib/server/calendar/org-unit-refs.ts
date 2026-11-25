// How many calendar events are tied to an org unit, for the kernel's committee delete
// ('calendar:org-unit-refs'). Read through the routed backend, so it answers from where the
// events really are: the kernel tables, or the calendar leaf's own database (where the link to
// the unit carries no foreign key and nothing cascades). A failure is passed on: the caller
// refuses the delete, it never reads "no answer" as "no events".
import { getCalendarBackend } from './backend'

/** The whole calendar: a meeting years ago still hangs on the body. */
const FROM = new Date(0)
const TO = new Date('9999-12-31T00:00:00Z')

export async function calendarRefsOfOrgUnit(
  orgUnitId: string,
): Promise<{ referenced: boolean; counts: Record<string, number> }> {
  const events = await getCalendarBackend().listEvents({ committeeId: orgUnitId, from: FROM, to: TO })
  return { referenced: events.length > 0, counts: { events: events.length } }
}
