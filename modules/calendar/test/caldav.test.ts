// services/calendar/test/caldav.test.ts
//
// Ported from gremion-ui/src/lib/server/calendar/caldav-client.test.ts (ICS
// shape, line folding, RRULE/EXDATE) plus new coverage for the leaf's direct
// WebDAV pusher (injected fetchImpl, PUT/DELETE target + Basic-auth header).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildIcs, dbEventToIcs, vtimezone } from '../src/caldav/client.js'
import { createCalDavPusher } from '../src/caldav/pusher.js'
import type { DbEvent } from '../src/store/index.js'

describe('buildIcs', () => {
  it('emits a VEVENT with UID, SUMMARY, DTSTART and DTEND', () => {
    const ics = buildIcs({
      uid: 'abc-123',
      summary: 'Test-Termin',
      description: null,
      location: null,
      dtstart: new Date('2026-05-01T10:00:00Z'),
      dtend: new Date('2026-05-01T11:00:00Z'),
      allDay: false,
    })
    expect(ics).toContain('BEGIN:VCALENDAR')
    expect(ics).toContain('BEGIN:VEVENT')
    expect(ics).toContain('UID:abc-123')
    expect(ics).toContain('SUMMARY:Test-Termin')
    expect(ics).toContain('DTSTART;TZID=Europe/Berlin:')
    expect(ics).toContain('DTEND;TZID=Europe/Berlin:')
    expect(ics).toContain('END:VEVENT')
    expect(ics).toContain('END:VCALENDAR')
  })

  it('uses DATE-only format for all-day events', () => {
    const ics = buildIcs({
      uid: 'all-day-1',
      summary: 'Feiertag',
      description: null,
      location: null,
      dtstart: new Date('2026-05-01T00:00:00Z'),
      dtend: new Date('2026-05-01T23:59:59Z'),
      allDay: true,
    })
    expect(ics).toContain('DTSTART;VALUE=DATE:20260501')
    expect(ics).not.toContain('DTSTART;TZID=')
  })

  it('escapes commas, semicolons, and newlines in text fields per RFC 5545', () => {
    const ics = buildIcs({
      uid: 'esc-1',
      summary: 'Title; with, reserved\ncharacters',
      description: 'Line 1\nLine 2',
      location: null,
      dtstart: new Date('2026-05-01T10:00:00Z'),
      dtend: new Date('2026-05-01T11:00:00Z'),
      allDay: false,
    })
    expect(ics).toContain('SUMMARY:Title\\; with\\, reserved\\ncharacters')
    expect(ics).toContain('DESCRIPTION:Line 1\\nLine 2')
  })

  it('emits a weekly RRULE with BYDAY and COUNT when a recurrence is provided', () => {
    const ics = buildIcs({
      uid: 'rec-1',
      summary: 'Recurring',
      description: null,
      location: null,
      dtstart: new Date('2026-05-04T14:00:00Z'),
      dtend: new Date('2026-05-04T15:00:00Z'),
      allDay: false,
      recurrence: {
        frequency: 'weekly',
        interval: 2,
        until: null,
        count: 12,
        byday: ['MO', 'WE'],
        exceptions: null,
      },
    })
    expect(ics).toContain('RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=12;BYDAY=MO,WE')
  })

  it('emits EXDATE when exceptions are present', () => {
    const ics = buildIcs({
      uid: 'rec-exc',
      summary: 'Recurring w/ skip',
      description: null,
      location: null,
      dtstart: new Date('2026-05-04T14:00:00Z'),
      dtend: new Date('2026-05-04T15:00:00Z'),
      allDay: false,
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        until: null,
        count: null,
        byday: null,
        exceptions: [new Date('2026-05-18T14:00:00Z')],
      },
    })
    expect(ics).toMatch(/EXDATE;TZID=Europe\/Berlin:/)
  })

  it('folds lines longer than 75 octets per RFC 5545 3.1', () => {
    const longSummary = 'A'.repeat(120)
    const ics = buildIcs({
      uid: 'fold-1',
      summary: longSummary,
      description: null,
      location: null,
      dtstart: new Date('2026-05-01T10:00:00Z'),
      dtend: new Date('2026-05-01T11:00:00Z'),
      allDay: false,
    })
    const summaryLine = ics.split('\r\n').find((l) => l.startsWith('SUMMARY:'))
    expect(summaryLine).toBeDefined()
    expect(summaryLine!.length).toBeLessThanOrEqual(75)
    // continuation line(s) start with a single space per RFC 5545 folding.
    const idx = ics.indexOf('SUMMARY:')
    const rest = ics.slice(idx)
    const lines = rest.split('\r\n')
    expect(lines[1]?.startsWith(' ')).toBe(true)
  })
})

// F1-FIX-08 (S1c#13), leaf twin of the in-process caldav-client tests: a TZID
// property never carries a UTC 'Z' value (RFC 5545 3.3.5), timed values are
// Europe/Berlin wall time, all-day DTEND is exclusive, and recurrence
// until/exceptions (DATE columns) name Berlin civil days.
describe('buildIcs - RFC 5545 wall times and civil-day recurrence (F1-FIX-08)', () => {
  const unfold = (ics: string) => ics.replace(/\r\n /g, '')
  const lineOf = (ics: string, prop: string) =>
    unfold(ics).split('BEGIN:VEVENT')[1]!.split('\r\n').find((l) => l.startsWith(prop))
  const base = { description: null, location: null }

  it('timed values are Europe/Berlin wall time with TZID and no Z (winter and summer)', () => {
    const winter = buildIcs({
      ...base, uid: 'w', summary: 'x', allDay: false,
      dtstart: new Date('2026-01-05T17:00:00Z'), dtend: new Date('2026-06-15T13:30:00Z'),
    })
    expect(lineOf(winter, 'DTSTART')).toBe('DTSTART;TZID=Europe/Berlin:20260105T180000')
    expect(lineOf(winter, 'DTEND')).toBe('DTEND;TZID=Europe/Berlin:20260615T153000')

    const summer = buildIcs({
      ...base, uid: 's', summary: 'x', allDay: false,
      dtstart: new Date('2026-05-01T10:00:00Z'), dtend: new Date('2026-05-01T11:00:00Z'),
    })
    expect(lineOf(summer, 'DTSTART')).toBe('DTSTART;TZID=Europe/Berlin:20260501T120000')
  })

  it('DTSTAMP stays UTC with Z', () => {
    const ics = buildIcs({
      ...base, uid: 'z', summary: 'x', allDay: false,
      dtstart: new Date('2026-01-05T17:00:00Z'), dtend: new Date('2026-01-05T18:00:00Z'),
    })
    expect(lineOf(ics, 'DTSTAMP')).toMatch(/^DTSTAMP:\d{8}T\d{6}Z$/)
  })

  it('a weekly series keeps the same local wall time across the DST change', () => {
    // 18:00 Berlin before (CET, 17:00Z) and after (CEST, 16:00Z) the 2026-03-29 switch:
    // both instances render as T180000, and the series DTSTART carries the wall time.
    const before = buildIcs({
      ...base, uid: 'dst-a', summary: 'x', allDay: false,
      dtstart: new Date('2026-03-23T17:00:00Z'), dtend: new Date('2026-03-23T18:00:00Z'),
    })
    const after = buildIcs({
      ...base, uid: 'dst-b', summary: 'x', allDay: false,
      dtstart: new Date('2026-03-30T16:00:00Z'), dtend: new Date('2026-03-30T17:00:00Z'),
    })
    expect(lineOf(before, 'DTSTART')).toBe('DTSTART;TZID=Europe/Berlin:20260323T180000')
    expect(lineOf(after, 'DTSTART')).toBe('DTSTART;TZID=Europe/Berlin:20260330T180000')
  })

  it('all-day DTEND is exclusive (inclusive stored end and already-exclusive stored end)', () => {
    const inclusive = buildIcs({
      ...base, uid: 'h', summary: 'Feiertag', allDay: true,
      dtstart: new Date('2026-10-03T00:00:00Z'), dtend: new Date('2026-10-03T23:59:59Z'),
    })
    expect(lineOf(inclusive, 'DTEND')).toBe('DTEND;VALUE=DATE:20261004')
    const exclusive = buildIcs({
      ...base, uid: 'h2', summary: 'Feiertag', allDay: true,
      dtstart: new Date('2026-10-03T00:00:00Z'), dtend: new Date('2026-10-04T00:00:00Z'),
    })
    expect(lineOf(exclusive, 'DTEND')).toBe('DTEND;VALUE=DATE:20261004')
  })

  it('timed EXDATE is the exception day at the DTSTART wall time; timed UNTIL is the last second of the day in UTC', () => {
    const ics = buildIcs({
      ...base, uid: 'r', summary: 'x', allDay: false,
      dtstart: new Date('2026-01-05T17:00:00Z'), dtend: new Date('2026-01-05T18:00:00Z'),
      recurrence: {
        frequency: 'weekly', interval: 1, count: null,
        until: new Date('2026-03-30T16:00:00Z'), exceptions: [new Date('2026-01-12T17:00:00Z')],
        byday: ['MO'],
      },
    })
    expect(lineOf(ics, 'EXDATE')).toBe('EXDATE;TZID=Europe/Berlin:20260112T180000')
    // 2026-03-30 is CEST: the Berlin day ends 21:59:59Z.
    expect(lineOf(ics, 'RRULE')).toBe('RRULE:FREQ=WEEKLY;UNTIL=20260330T215959Z;BYDAY=MO')
  })

  it('DATE-shaped until / exceptions (UTC midnight from the DATE column) name the Berlin civil day', () => {
    const ics = buildIcs({
      ...base, uid: 'd', summary: 'x', allDay: false,
      dtstart: new Date('2026-01-05T17:00:00Z'), dtend: new Date('2026-01-05T18:00:00Z'),
      recurrence: {
        frequency: 'weekly', interval: 1, count: null, byday: null,
        until: new Date('2026-01-19'), exceptions: [new Date('2026-01-12')],
      },
    })
    // The 18:00 meeting on 2026-01-19 stays in: UNTIL is 22:59:59Z that day (CET).
    expect(lineOf(ics, 'RRULE')).toBe('RRULE:FREQ=WEEKLY;UNTIL=20260119T225959Z')
    expect(lineOf(ics, 'EXDATE')).toBe('EXDATE;TZID=Europe/Berlin:20260112T180000')
  })

  it('Berlin-midnight until resolves to the same civil day as the UTC-midnight form', () => {
    const rec = (until: Date) => ({
      frequency: 'weekly' as const, interval: 1, count: null, byday: null, exceptions: null, until,
    })
    const args = {
      ...base, uid: 'm', summary: 'x', allDay: false,
      dtstart: new Date('2026-01-05T17:00:00Z'), dtend: new Date('2026-01-05T18:00:00Z'),
    }
    const utcMidnight = buildIcs({ ...args, recurrence: rec(new Date('2026-01-19T00:00:00Z')) })
    const berlinMidnight = buildIcs({ ...args, recurrence: rec(new Date('2026-01-18T23:00:00Z')) })
    expect(lineOf(utcMidnight, 'RRULE')).toBe('RRULE:FREQ=WEEKLY;UNTIL=20260119T225959Z')
    expect(lineOf(berlinMidnight, 'RRULE')).toBe('RRULE:FREQ=WEEKLY;UNTIL=20260119T225959Z')
  })

  it('all-day series: UNTIL and EXDATE are the civil date (also from Berlin midnight)', () => {
    const ics = buildIcs({
      ...base, uid: 'a', summary: 'x', allDay: true,
      dtstart: new Date('2026-01-05T00:00:00Z'), dtend: new Date('2026-01-05T23:59:59Z'),
      recurrence: {
        frequency: 'weekly', interval: 1, count: null, byday: null,
        until: new Date('2026-01-18T23:00:00Z'), exceptions: [new Date('2026-01-11T23:00:00Z')],
      },
    })
    expect(lineOf(ics, 'RRULE')).toBe('RRULE:FREQ=WEEKLY;UNTIL=20260119')
    expect(lineOf(ics, 'EXDATE')).toBe('EXDATE;VALUE=DATE:20260112')
  })

  it('PRODID carries the product name, not a deployment name', () => {
    const ics = buildIcs({
      ...base, uid: 'p', summary: 'x', allDay: false,
      dtstart: new Date('2026-01-05T17:00:00Z'), dtend: new Date('2026-01-05T18:00:00Z'),
    })
    expect(ics).toContain('PRODID:-//Gremion//Gremion Calendar//DE')
  })
})

describe('vtimezone', () => {
  it('emits a static Europe/Berlin VTIMEZONE block', () => {
    const vtz = vtimezone()
    expect(vtz).toContain('BEGIN:VTIMEZONE')
    expect(vtz).toContain('TZID:Europe/Berlin')
    expect(vtz).toContain('BEGIN:DAYLIGHT')
    expect(vtz).toContain('BEGIN:STANDARD')
    expect(vtz).toContain('END:VTIMEZONE')
  })
})

describe('dbEventToIcs', () => {
  it('maps a DbEvent to the minimal IcsEvent shape buildIcs expects', () => {
    const dbEvent: DbEvent = {
      id: 'evt-1',
      title: 'Sitzung',
      description: 'Beschreibung',
      location: 'Raum 1',
      startAt: new Date('2026-06-01T10:00:00Z'),
      endAt: new Date('2026-06-01T11:00:00Z'),
      allDay: false,
      eventTypeId: null,
      eventTypeColor: null,
      eventTypeName: null,
      isMultiCommittee: false,
      createdBy: 'user-1',
      source: 'manual',
      externalId: null,
      caldavUid: 'caldav-uid-1@stura',
      caldavSyncedAt: null,
      createdAt: new Date('2026-05-01T00:00:00Z'),
      updatedAt: new Date('2026-05-01T00:00:00Z'),
      committeeIds: [],
      recurrence: null,
      colour: { primary: '#000000', secondary: '#ffffff' },
    }
    const icsEvent = dbEventToIcs(dbEvent)
    expect(icsEvent.uid).toBe('caldav-uid-1@stura')
    expect(icsEvent.summary).toBe('Sitzung')
    expect(icsEvent.description).toBe('Beschreibung')
    expect(icsEvent.location).toBe('Raum 1')
    expect(icsEvent.dtstart).toEqual(dbEvent.startAt)
    expect(icsEvent.dtend).toEqual(dbEvent.endAt)
    expect(icsEvent.allDay).toBe(false)
    expect(icsEvent.recurrence).toBeNull()
  })

  it('falls back to the event id when caldavUid is null', () => {
    const dbEvent: DbEvent = {
      id: 'evt-2',
      title: 'Ohne CalDAV UID',
      description: null,
      location: null,
      startAt: new Date('2026-06-02T10:00:00Z'),
      endAt: new Date('2026-06-02T11:00:00Z'),
      allDay: false,
      eventTypeId: null,
      eventTypeColor: null,
      eventTypeName: null,
      isMultiCommittee: false,
      createdBy: 'user-1',
      source: 'manual',
      externalId: null,
      caldavUid: null,
      caldavSyncedAt: null,
      createdAt: new Date('2026-05-01T00:00:00Z'),
      updatedAt: new Date('2026-05-01T00:00:00Z'),
      committeeIds: [],
      recurrence: null,
      colour: { primary: '#000000', secondary: '#ffffff' },
    }
    const icsEvent = dbEventToIcs(dbEvent)
    expect(icsEvent.uid).toBe('evt-2')
  })
})

describe('createCalDavPusher', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    process.env.NEXTCLOUD_URL = 'http://nextcloud.internal'
    process.env.NEXTCLOUD_ADMIN_USER = 'admin'
    process.env.NEXTCLOUD_ADMIN_PASSWORD = 'secret-pw'
    process.env.CALDAV_SHARED_USER = 'calshare'
    process.env.CALDAV_SHARED_CALENDAR = 'stura'
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    vi.restoreAllMocks()
  })

  const expectedAuthHeader = 'Basic ' + Buffer.from('admin:secret-pw').toString('base64')
  const calPath = '/remote.php/dav/calendars/calshare/stura/'

  it('pushCreate PUTs the ICS body to the shared calendar with Basic auth', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }))
    const pusher = createCalDavPusher({ fetchImpl })

    await pusher.pushCreate({
      uid: 'evt-uid-1',
      summary: 'Neuer Termin',
      description: null,
      location: null,
      dtstart: new Date('2026-06-01T10:00:00Z'),
      dtend: new Date('2026-06-01T11:00:00Z'),
      allDay: false,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://nextcloud.internal' + calPath + 'evt-uid-1.ics')
    expect(init.method).toBe('PUT')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe(expectedAuthHeader)
    expect(headers['Content-Type']).toContain('text/calendar')
    expect(typeof init.body).toBe('string')
    expect(init.body as string).toContain('UID:evt-uid-1')
  })

  it('pushUpdate PUTs to the same target as pushCreate', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const pusher = createCalDavPusher({ fetchImpl })

    await pusher.pushUpdate({
      uid: 'evt-uid-2',
      summary: 'Geänderter Termin',
      description: null,
      location: null,
      dtstart: new Date('2026-06-02T10:00:00Z'),
      dtend: new Date('2026-06-02T11:00:00Z'),
      allDay: false,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://nextcloud.internal' + calPath + 'evt-uid-2.ics')
    expect(init.method).toBe('PUT')
  })

  it('pushDelete DELETEs the event by UID with Basic auth', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const pusher = createCalDavPusher({ fetchImpl })

    await pusher.pushDelete('evt-uid-3')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://nextcloud.internal' + calPath + 'evt-uid-3.ics')
    expect(init.method).toBe('DELETE')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe(expectedAuthHeader)
  })

  it('throws a descriptive error on a non-OK response', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    )
    const pusher = createCalDavPusher({ fetchImpl })

    await expect(
      pusher.pushCreate({
        uid: 'evt-uid-err',
        summary: 'Fehlerfall',
        description: null,
        location: null,
        dtstart: new Date('2026-06-03T10:00:00Z'),
        dtend: new Date('2026-06-03T11:00:00Z'),
        allDay: false,
      }),
    ).rejects.toThrow(/500/)
  })

  it('defaults NEXTCLOUD_ADMIN_USER for the shared user when CALDAV_SHARED_USER is unset', async () => {
    delete process.env.CALDAV_SHARED_USER
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const pusher = createCalDavPusher({ fetchImpl })

    await pusher.pushDelete('evt-uid-4')

    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://nextcloud.internal/remote.php/dav/calendars/admin/stura/evt-uid-4.ics')
  })
})
