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
