// src/lib/server/seed/seed-calendar.ts
// P0 demo calendar fixtures (behind SEED_DEMO_FIXTURES). Anchors every event on
// the seed-time clock so the dashboard hero ("StuRa-Plenum Nr. 247" — today
// 18:00) stays faithful over time. createEvent enqueues a CalDAV push, which is
// fine in the seed path (the worker drains it). eventTypeId stays null — the
// colour resolves from the committee's calendar settings.
import { createEvent } from '../calendar/calendar-db'

/** Build a Date on today's clock at the given local hour:minute. */
function todayAt(hour: number, minute: number): Date {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  return d
}

/** Build a Date `days` from today at the given local hour:minute. */
function inDaysAt(days: number, hour: number, minute: number): Date {
  const d = new Date()
  d.setDate(d.getDate() + days)
  d.setHours(hour, minute, 0, 0)
  return d
}

/** Days until the next occurrence of `weekday` (0=Sun..6=Sat), strictly in the
 *  future (>= 1 so "next Wednesday" never resolves to today). */
function daysUntilNext(weekday: number): number {
  const today = new Date().getDay()
  const delta = (weekday - today + 7) % 7
  return delta === 0 ? 7 : delta
}

export async function seedCalendar(
  orgUnitIds: ReadonlyMap<string, string>,
  userIds: ReadonlyMap<string, string>
): Promise<number> {
  const ou = (key: string): string => {
    const id = orgUnitIds.get(key)
    if (id === undefined) throw new Error(`seedCalendar: unknown org-unit key "${key}"`)
    return id
  }
  const user = (username: string): string => {
    const id = userIds.get(username)
    if (id === undefined) throw new Error(`seedCalendar: unknown user "${username}"`)
    return id
  }

  const events: Array<{
    title: string
    location: string
    start: Date
    end: Date
    committeeKey: string
    createdByUsername: string
  }> = [
    {
      title: 'StuRa-Plenum Nr. 247',
      location: 'HB-1.27 · Hybrid (Element Call)',
      start: todayAt(18, 0),
      end: todayAt(20, 0),
      committeeKey: 'studierendenrat',
      createdByUsername: 'anna.berger',
    },
    {
      title: 'Vorstandssitzung',
      location: 'BibSaal',
      start: inDaysAt(daysUntilNext(3), 14, 0), // next Wednesday
      end: inDaysAt(daysUntilNext(3), 15, 30),
      committeeKey: 'vorstand',
      createdByUsername: 'anna.berger',
    },
    {
      title: 'Referat Finanzen',
      location: 'HB-2.04 · Sitzung intern',
      start: inDaysAt(daysUntilNext(4), 16, 30), // next Thursday
      end: inDaysAt(daysUntilNext(4), 18, 0),
      committeeKey: 'ref-finanzen',
      createdByUsername: 'anna.berger',
    },
    {
      title: 'AG Nachhaltigkeit',
      location: '#ag-nachhaltigkeit · Online',
      start: inDaysAt(daysUntilNext(5), 10, 0), // next Friday
      end: inDaysAt(daysUntilNext(5), 11, 0),
      committeeKey: 'ag-nachhaltigkeit',
      createdByUsername: 'anna.berger',
    },
  ]

  let count = 0
  for (const e of events) {
    await createEvent({
      title: e.title,
      description: null,
      location: e.location,
      startAt: e.start,
      endAt: e.end,
      allDay: false,
      eventTypeId: null,
      isMultiCommittee: false,
      createdBy: user(e.createdByUsername),
      source: 'manual',
      externalId: null,
      committeeIds: [ou(e.committeeKey)],
      recurrence: null,
    })
    count++
  }
  return count
}
