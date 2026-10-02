// CalDAV push-only client — Stream B1.
//
// The stura Postgres DB is the source of truth for all calendar events. This
// module exists solely to propagate changes OUT to Nextcloud CalDAV so
// external clients (iOS Calendar, Thunderbird, Apple Calendar, …) still see
// StuRaOS events. Reads from CalDAV are no longer performed by the app.
//
// Entry points:
//   • buildIcs(event)                          — render ICS body for PUT
//   • createCalDavPusher()                     — factory
//   • pusher.pushCreate / pushUpdate / pushDelete — low-level ops used by the
//                                                  caldav-sync worker
//
// The pusher targets a "shared calendar" owned by an admin account:
//   /remote.php/dav/calendars/{CALDAV_SHARED_USER}/{CALDAV_SHARED_CALENDAR}/
//
// Both names are sourced from env with sensible defaults, keeping setup
// deterministic across dev and k8s. The Nextcloud admin impersonation flow
// (already used by NextcloudClient) handles writes on that user's behalf.

import { env } from '$env/dynamic/private'
import { defaultTenantEnv } from '$lib/server/tenant/default-env'
import {
  createNextcloudClient,
  NextcloudResponseError,
  type NextcloudClient,
  type CalendarInfo,
} from '../files/nextcloud-client'
import type { DbEvent, DbRecurrence } from './calendar-db'
import { berlinWallHms, civilDayYmd, endOfUntilDay, recurrenceDateDay } from './recurrence-expand'

export type { CalendarInfo }

// ─── ICS builder ──────────────────────────────────────────────────────────────

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

// RFC 5545 §3.1 — wrap content lines at 75 OCTETS (UTF-8), never inside a
// multi-byte character (F1-FIX-08, S1c#13; mirrors services/calendar client.ts).
function foldLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line
  const parts: string[] = []
  let current = ''
  let currentBytes = 0
  for (const ch of line) {
    const bytes = Buffer.byteLength(ch, 'utf8')
    if (currentBytes + bytes > 75) {
      parts.push(current)
      current = ' '
      currentBytes = 1
    }
    current += ch
    currentBytes += bytes
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

// F1-FIX-08 (S1c#13): no UTC 'Z' on a TZID property. Timed DTSTART/DTEND/
// EXDATE are Europe/Berlin wall time with TZID (keeps a series at the same
// local time across DST); DTSTAMP and RRULE UNTIL stay UTC.
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

/** All-day DTEND is EXCLUSIVE (RFC 5545 §3.6.1): the day after the last day. */
function allDayExclusiveEnd(start: Date, end: Date): string {
  const lastDay = new Date(Math.max(end.getTime() - 1, start.getTime()))
  return formatDate(new Date(Date.UTC(lastDay.getUTCFullYear(), lastDay.getUTCMonth(), lastDay.getUTCDate() + 1)))
}

/** RFC 5545 weekday with an optional ordinal (e.g. MO, -1FR, 2TU). */
const BYDAY_RE = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/

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
  // r.until is a DATE column (an inclusive civil day): the timed form is the
  // last second of that Berlin day, so the meeting on the end date stays in.
  if (r.until) {
    parts.push(`UNTIL=${allDay ? civilDayYmd(recurrenceDateDay(r.until)) : formatUtc(endOfUntilDay(r.until))}`)
  }
  // K4#21: only RFC 5545 weekdays — anything else (CRLF, property text) is dropped.
  const byday = (r.byday ?? []).map((d) => d.trim().toUpperCase()).filter((d) => BYDAY_RE.test(d))
  if (byday.length > 0) parts.push(`BYDAY=${byday.join(',')}`)
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
    lines.push(foldLine('RRULE:' + buildRRule(event.recurrence, event.allDay)))
    if (event.recurrence.exceptions && event.recurrence.exceptions.length > 0) {
      // exceptions are DATE values (civil days): a timed EXDATE is that day at
      // DTSTART's Berlin wall time, so it matches the instance it removes.
      const wallTime = berlinWallHms(event.dtstart)
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

/** Helper: convert a DbEvent into the minimal input buildIcs expects. */
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

// ─── Pusher ───────────────────────────────────────────────────────────────────

export class CalDavPusher {
  constructor(
    private readonly nc: NextcloudClient,
    private readonly userId: string,
    private readonly calendarName: string,
  ) {}

  /** Computed CalDAV collection path, e.g. /remote.php/dav/calendars/admin/stura/ */
  get calPath(): string {
    return (
      '/remote.php/dav/calendars/' +
      encodeURIComponent(this.userId) +
      '/' +
      encodeURIComponent(this.calendarName) +
      '/'
    )
  }

  /** Upload a new event (PUT to CalDAV). */
  async pushCreate(event: IcsEvent): Promise<void> {
    const ics = buildIcs(event)
    await this.nc.createOrUpdateEvent(this.calPath, event.uid, this.userId, ics)
  }

  /** Update an existing event (PUT replaces). Same wire call as create. */
  async pushUpdate(event: IcsEvent): Promise<void> {
    const ics = buildIcs(event)
    await this.nc.createOrUpdateEvent(this.calPath, event.uid, this.userId, ics)
  }

  /**
   * Remove an event by UID. Resolves true when a copy was removed, false when
   * there was none: 404/410 is the goal of a delete (never synced, or already
   * gone), mirroring the leaf pusher (K4#6 / S4#12). The D-2 update path
   * DELETEs every private event's copy, so a 404 is routine there; treating
   * it as a failure dead-lettered those rows. Other statuses still throw.
   */
  async pushDelete(uid: string): Promise<boolean> {
    const eventPath = this.calPath.replace(/\/$/, '') + '/' + uid + '.ics'
    try {
      await this.nc.deleteEvent(eventPath, this.userId)
      return true
    } catch (err) {
      const status = err instanceof NextcloudResponseError ? err.status : undefined
      if (status === 404 || status === 410) return false
      throw err
    }
  }

  /**
   * Ensure the configured shared calendar exists on Nextcloud. Safe to call
   * at startup; no-op if the calendar is already present.
   */
  async ensureCalendar(): Promise<CalendarInfo | null> {
    const calendars = await this.nc.listCalendars(this.userId)
    const match = calendars.find(
      (c) => c.href === this.calPath || c.displayName === this.calendarName,
    )
    return match ?? null
  }
}

/**
 * F1-FIX-08 (H06): the drain passes the tenant's own collection (see
 * caldav-target.ts). Without a target the legacy env pair is used — only
 * direct callers (ensureCalendar tooling) rely on that.
 */
export function createCalDavPusher(target?: { user: string; calendar: string }): CalDavPusher {
  if (target) return new CalDavPusher(createNextcloudClient(), target.user, target.calendar)
  const userId = defaultTenantEnv('CALDAV_SHARED_USER') ?? defaultTenantEnv('NEXTCLOUD_ADMIN_USER') ?? 'admin'
  const calendarName = env.CALDAV_SHARED_CALENDAR ?? 'stura'
  return new CalDavPusher(createNextcloudClient(), userId, calendarName)
}
