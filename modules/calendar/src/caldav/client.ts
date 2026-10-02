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

function formatIcsDateTime(d: Date, allDay: boolean): string {
  if (allDay) return d.toISOString().slice(0, 10).replace(/-/g, '')
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function escapeText(s: string): string {
  // RFC 5545 §3.3.11 — escape backslash, comma, semicolon, and newlines.
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

function buildRRule(r: DbRecurrence): string {
  const parts: string[] = [`FREQ=${r.frequency.toUpperCase()}`]
  if (r.interval && r.interval > 1) parts.push(`INTERVAL=${r.interval}`)
  if (r.count) parts.push(`COUNT=${r.count}`)
  if (r.until)
    parts.push(`UNTIL=${formatIcsDateTime(r.until, false).replace(/Z$/, '') + 'Z'}`)
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
  const dtstamp = formatIcsDateTime(new Date(), false)
  const dtstart = formatIcsDateTime(event.dtstart, event.allDay)
  const dtend = formatIcsDateTime(event.dtend, event.allDay)

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//StuRaOS//StuRaOS Calendar//DE',
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
    lines.push(foldLine('RRULE:' + buildRRule(event.recurrence)))
    if (event.recurrence.exceptions && event.recurrence.exceptions.length > 0) {
      const exdates = event.recurrence.exceptions
        .map((d) => formatIcsDateTime(d, event.allDay))
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
