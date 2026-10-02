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
  type NextcloudClient,
  type CalendarInfo,
} from '../files/nextcloud-client'
import type { DbEvent, DbRecurrence } from './calendar-db'

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

// RFC 5545 §3.1 — wrap property values at 75 octets.
function foldLine(line: string): string {
  if (line.length <= 75) return line
  const parts: string[] = []
  parts.push(line.slice(0, 75))
  let i = 75
  while (i < line.length) {
    parts.push(' ' + line.slice(i, i + 74))
    i += 74
  }
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
  if (r.byday && r.byday.length > 0) parts.push(`BYDAY=${r.byday.join(',')}`)
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

  /** Remove an event by UID. */
  async pushDelete(uid: string): Promise<void> {
    const eventPath = this.calPath.replace(/\/$/, '') + '/' + uid + '.ics'
    await this.nc.deleteEvent(eventPath, this.userId)
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

export function createCalDavPusher(): CalDavPusher {
  const userId = defaultTenantEnv('CALDAV_SHARED_USER') ?? defaultTenantEnv('NEXTCLOUD_ADMIN_USER') ?? 'admin'
  const calendarName = env.CALDAV_SHARED_CALENDAR ?? 'stura'
  return new CalDavPusher(createNextcloudClient(), userId, calendarName)
}
