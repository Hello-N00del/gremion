// services/calendar/src/caldav/client.ts
//
// Pure ICS builder — ported VERBATIM from
// gremion-ui/src/lib/server/calendar/caldav-client.ts's ICS section. No kernel
// imports; depends only on the leaf's own DbEvent/DbRecurrence store types.
//
// Entry points:
//   • buildIcs(event)       — render ICS body for PUT
//   • dbEventToIcs(dbEvent) — map a leaf DbEvent into the minimal IcsEvent
//                             shape buildIcs expects
//   • vtimezone()           — static Europe/Berlin VTIMEZONE block

import type { DbEvent, DbRecurrence } from '../store/index.js'

export interface IcsEvent {
  uid: string
  summary: string
  description: string | null
  location: string | null
  dtstart: Date
  dtend: Date
  allDay: boolean
  /** Optional RRULE/EXDATE fields derived from DbRecurrence. */
  recurrence?: DbRecurrence | null
}

/** RFC 5545 BYDAY value: a weekday with an optional ordinal (1..53, signed). */
export const BYDAY_PATTERN = /^(?:[+-]?(?:[1-9]|[1-4]\d|5[0-3]))?(?:MO|TU|WE|TH|FR|SA|SU)$/

// RFC 5545 §3.1 — content lines are folded at 75 OCTETS (not UTF-16 units), and a
// continuation line starts with one space that counts toward the limit. Splits
// only ever fall on code-point boundaries.
export function foldLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line
  const parts: string[] = []
  let current = ''
  let used = 0
  let limit = 75
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (used + size > limit) {
      parts.push(current)
      current = ' '
      used = 1
      limit = 75
    }
    current += ch
    used += size
  }
  parts.push(current)
  return parts.join('\r\n')
}

// Static VTIMEZONE — Europe/Berlin (covers standard/daylight transitions).
export function vtimezone(): string {
  return [
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Berlin',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
    'END:STANDARD',
    'END:VTIMEZONE',
  ].join('\r\n')
}

// F1-FIX-08 (S1c#13): RFC 5545 forbids a UTC 'Z' value on a TZID property.
// Timed DTSTART/DTEND/EXDATE are written as Europe/Berlin wall time with TZID
// (the VTIMEZONE above), which also keeps a recurring series at the same
// local time across DST. DTSTAMP and a timed RRULE UNTIL stay UTC ('Z').
const berlinWall = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Berlin',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

function berlinParts(d: Date): Record<string, number> {
  const p: Record<string, number> = {}
  for (const part of berlinWall.formatToParts(d)) if (part.type !== 'literal') p[part.type] = Number(part.value)
  return p
}

function formatBerlinLocal(d: Date): string {
  const p: Record<string, string> = {}
  for (const part of berlinWall.formatToParts(d)) p[part.type] = part.value
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`
}

function formatUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

function formatIcsDateTime(d: Date, allDay: boolean): string {
  return allDay ? formatDate(d) : formatBerlinLocal(d)
}

// event_recurrence.until / exceptions are DATE columns. postgres.js returns them
// as UTC midnight (node-postgres under TZ=Europe/Berlin as Berlin midnight);
// either way they name a Europe/Berlin civil day, never an instant. Mirrors the
// in-process app half (modules/calendar/app recurrence-expand.ts); the leaf is
// standalone and cannot import it.
const DAY_MS = 86_400_000

/** Berlin civil day (days since epoch) of a recurrence DATE value. */
function recurrenceDateDay(value: Date | string): number {
  const p = berlinParts(new Date(value))
  return Date.UTC(p.year!, p.month! - 1, p.day!) / DAY_MS
}

function civilDayYmd(civilDay: number): string {
  return new Date(civilDay * DAY_MS).toISOString().slice(0, 10).replace(/-/g, '')
}

/** Last second of the until's Berlin civil day, as an instant (the UTC UNTIL). */
function endOfUntilDay(value: Date | string): Date {
  const naive = (recurrenceDateDay(value) + 1) * DAY_MS // next Berlin midnight, as if UTC
  const offsetAt = (t: number) => {
    const p = berlinParts(new Date(t))
    return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - t
  }
  let t = naive - offsetAt(naive)
  t = naive - offsetAt(t) // second pass fixes the DST edge
  return new Date(t - 1000)
}

/**
 * All-day DTEND is EXCLUSIVE (RFC 5545 3.6.1): the day after the last day.
 * Stored ends are inclusive (holidays: 23:59:59Z) or already exclusive (next
 * day 00:00Z); both map to the same exclusive date.
 */
function allDayExclusiveEnd(start: Date, end: Date): string {
  const lastDay = new Date(Math.max(end.getTime() - 1, start.getTime()))
  return formatDate(new Date(Date.UTC(lastDay.getUTCFullYear(), lastDay.getUTCMonth(), lastDay.getUTCDate() + 1)))
}

function escapeText(s: string): string {
  // RFC 5545 §3.3.11 — escape backslash, comma, semicolon, and newlines.
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

function buildRRule(r: DbRecurrence, allDay: boolean): string {
  const parts: string[] = [`FREQ=${r.frequency.toUpperCase()}`]
  if (r.interval && r.interval > 1) parts.push(`INTERVAL=${r.interval}`)
  if (r.count) parts.push(`COUNT=${r.count}`)
  // UNTIL takes the DTSTART value type: DATE for all-day, UTC for TZID times.
  // r.until is an inclusive civil day: the timed form is the last second of
  // that Berlin day, so the meeting on the end date stays in the series.
  if (r.until) {
    parts.push(`UNTIL=${allDay ? civilDayYmd(recurrenceDateDay(r.until)) : formatUtc(endOfUntilDay(r.until))}`)
  }
  if (r.byday && r.byday.length > 0) {
    // K4#21: defence in depth behind the API schema - a raw string here would
    // be CRLF / property injection into the ICS body.
    for (const d of r.byday) {
      if (!BYDAY_PATTERN.test(d)) throw new Error(`invalid RRULE BYDAY value: ${JSON.stringify(d)}`)
    }
    parts.push(`BYDAY=${r.byday.join(',')}`)
  }
  return parts.join(';')
}

export function buildIcs(event: IcsEvent): string {
  const dtstamp = formatUtc(new Date())
  const dtstart = formatIcsDateTime(event.dtstart, event.allDay)
  const dtend = event.allDay
    ? allDayExclusiveEnd(event.dtstart, event.dtend)
    : formatIcsDateTime(event.dtend, false)

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Gremion//Gremion Calendar//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    vtimezone(),
    'BEGIN:VEVENT',
    foldLine('UID:' + event.uid),
    foldLine('DTSTAMP:' + dtstamp),
    event.allDay
      ? foldLine('DTSTART;VALUE=DATE:' + dtstart)
      : foldLine('DTSTART;TZID=Europe/Berlin:' + dtstart),
    event.allDay
      ? foldLine('DTEND;VALUE=DATE:' + dtend)
      : foldLine('DTEND;TZID=Europe/Berlin:' + dtend),
    foldLine('SUMMARY:' + escapeText(event.summary)),
  ]
  if (event.description)
    lines.push(foldLine('DESCRIPTION:' + escapeText(event.description)))
  if (event.location)
    lines.push(foldLine('LOCATION:' + escapeText(event.location)))

  if (event.recurrence) {
    lines.push(foldLine('RRULE:' + buildRRule(event.recurrence, event.allDay)))
    if (event.recurrence.exceptions && event.recurrence.exceptions.length > 0) {
      // exceptions are DATE values (civil days): a timed EXDATE is that day at
      // DTSTART's Berlin wall time, so it matches the instance it removes.
      const wallTime = formatBerlinLocal(event.dtstart).slice(9)
      const exdates = event.recurrence.exceptions
        .map((d) => {
          const ymd = civilDayYmd(recurrenceDateDay(d))
          return event.allDay ? ymd : `${ymd}T${wallTime}`
        })
        .join(',')
      lines.push(
        foldLine(
          event.allDay
            ? 'EXDATE;VALUE=DATE:' + exdates
            : 'EXDATE;TZID=Europe/Berlin:' + exdates,
        ),
      )
    }
  }

  lines.push('END:VEVENT', 'END:VCALENDAR')
  return lines.join('\r\n')
}

/** Helper: convert a leaf DbEvent into the minimal input buildIcs expects. */
export function dbEventToIcs(event: DbEvent): IcsEvent {
  return {
    uid: event.caldavUid ?? event.id,
    summary: event.title,
    description: event.description,
    location: event.location,
    dtstart: event.startAt,
    dtend: event.endAt,
    allDay: event.allDay,
    recurrence: event.recurrence,
  }
}
