import { describe, it, expect } from 'vitest'
import { buildIcs } from './caldav-client'

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
})
