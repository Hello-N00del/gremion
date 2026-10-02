// Calendar stores — Stream B1.
// The new event shape matches the DbEvent payload returned by
// /api/calendar/events, including server-computed dual-tone colours and the
// readOnly flag for automation-sourced events.

import { writable, derived, get, type Writable, type Readable } from 'svelte/store'

export interface CalendarViewEvent {
  /** UUID from calendar_events.id (path param for PATCH/DELETE). */
  id: string
  /** Legacy alias — kept so existing keyed blocks `(ev.uid)` still work. */
  uid: string
  title: string
  /** Alias for title — kept for existing Badge/List markup. */
  summary: string
  description: string | null
  location: string | null
  dtstart: Date
  dtend: Date
  allDay: boolean
  eventTypeId: string | null
  eventTypeName: string | null
  committeeIds: string[]
  colour: { primary: string; secondary: string }
  readOnly: boolean
  source: string
}

export interface CalendarFilter {
  committeeId: string | null
  eventTypeId: string | null
}

export const calendarEvents: Writable<CalendarViewEvent[]> = writable([])
export const calendarView: Writable<'month' | 'week' | 'agenda'> = writable('month')
export const calendarDate: Writable<Date> = writable(new Date())
export const calendarFilter: Writable<CalendarFilter> = writable({
  committeeId: null,
  eventTypeId: null,
})

export const visibleRange: Readable<{ from: Date; to: Date }> = derived(
  [calendarView, calendarDate],
  ([$view, $date]) => {
    const d = new Date($date)
    if ($view === 'month') {
      const from = new Date(d.getFullYear(), d.getMonth(), 1)
      const to = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59)
      return { from, to }
    } else if ($view === 'week') {
      const day = d.getDay()
      const diff = day === 0 ? -6 : 1 - day // Monday start
      const from = new Date(d)
      from.setDate(d.getDate() + diff)
      from.setHours(0, 0, 0, 0)
      const to = new Date(from)
      to.setDate(from.getDate() + 6)
      to.setHours(23, 59, 59, 999)
      return { from, to }
    } else {
      // agenda: today + 30 days
      const from = new Date()
      from.setHours(0, 0, 0, 0)
      const to = new Date(from)
      to.setDate(from.getDate() + 30)
      to.setHours(23, 59, 59, 999)
      return { from, to }
    }
  },
)

interface RawDbEvent {
  id: string
  title: string
  description: string | null
  location: string | null
  startAt: string
  endAt: string
  allDay: boolean
  eventTypeId: string | null
  eventTypeName: string | null
  committeeIds: string[]
  colour: { primary: string; secondary: string }
  readOnly: boolean
  source: string
}

export async function loadEvents(from: Date, to: Date): Promise<void> {
  const filter = get(calendarFilter)
  const params = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
  })
  if (filter.committeeId) params.set('committeeId', filter.committeeId)
  if (filter.eventTypeId) params.set('eventTypeId', filter.eventTypeId)

  const res = await fetch('/api/calendar/events?' + params.toString())
  if (!res.ok) return
  const json = (await res.json()) as { success: boolean; data?: RawDbEvent[] }
  if (!json.success || !json.data) return

  calendarEvents.set(
    json.data.map((ev) => ({
      id: ev.id,
      uid: ev.id,
      title: ev.title,
      summary: ev.title,
      description: ev.description,
      location: ev.location,
      dtstart: new Date(ev.startAt),
      dtend: new Date(ev.endAt),
      allDay: ev.allDay,
      eventTypeId: ev.eventTypeId,
      eventTypeName: ev.eventTypeName,
      committeeIds: ev.committeeIds,
      colour: ev.colour,
      readOnly: ev.readOnly,
      source: ev.source,
    })),
  )
}
