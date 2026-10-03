import { describe, it, expect } from 'vitest'
import { buildIcs } from './caldav-client'

// F1-FIX-08 (S1c#13 / K4#21), in-process twin of the leaf golden tests.
describe('buildIcs — RFC 5545 validity (F1-FIX-08)', () => {
  const unfold = (ics: string) => ics.replace(/\r\n /g, '')
  const lineOf = (ics: string, prop: string) =>
    unfold(ics).split('BEGIN:VEVENT')[1]!.split('\r\n').find((l) => l.startsWith(prop))
  const base = { description: null, location: null }

  it('timed values are Europe/Berlin wall time with TZID and no Z', () => {
    const ics = buildIcs({
      ...base, uid: 'w', summary: 'x', allDay: false,
      dtstart: new Date('2026-01-05T17:00:00Z'), dtend: new Date('2026-06-15T13:30:00Z'),
    })
    expect(lineOf(ics, 'DTSTART')).toBe('DTSTART;TZID=Europe/Berlin:20260105T180000')
    expect(lineOf(ics, 'DTEND')).toBe('DTEND;TZID=Europe/Berlin:20260615T153000')
  })

  it('all-day DTEND is exclusive', () => {
    const ics = buildIcs({
      ...base, uid: 'h', summary: 'Feiertag', allDay: true,
      dtstart: new Date('2026-10-03T00:00:00Z'), dtend: new Date('2026-10-03T23:59:59Z'),
    })
    expect(lineOf(ics, 'DTEND')).toBe('DTEND;VALUE=DATE:20261004')
  })

  it('EXDATE in local time; UNTIL in UTC; invalid BYDAY dropped', () => {
    const ics = buildIcs({
      ...base, uid: 'r', summary: 'x', allDay: false,
      dtstart: new Date('2026-01-05T17:00:00Z'), dtend: new Date('2026-01-05T18:00:00Z'),
      recurrence: {
        frequency: 'weekly', interval: 1, count: null,
        until: new Date('2026-03-30T16:00:00Z'), exceptions: [new Date('2026-01-12T17:00:00Z')],
        byday: ['MO', 'WE\r\nATTENDEE:mailto:x@example.org'],
      },
    })
    expect(lineOf(ics, 'EXDATE')).toBe('EXDATE;TZID=Europe/Berlin:20260112T180000')
    // UNTIL is the end of the until's Berlin civil day (2026-03-30, CEST), in UTC.
    expect(lineOf(ics, 'RRULE')).toBe('RRULE:FREQ=WEEKLY;UNTIL=20260330T215959Z;BYDAY=MO')
    expect(ics).not.toContain('ATTENDEE')
  })

  // Round 2: until / exceptions arrive from DATE columns as UTC midnight. A
  // timed UNTIL of 20260119T000000Z excluded the 18:00 meeting on the end day,
  // and a timed EXDATE of T010000 never matched an instance.
  it('DB DATE until / exceptions: UNTIL covers the whole end day, EXDATE carries the DTSTART wall time', () => {
    const ics = buildIcs({
      ...base, uid: 'd', summary: 'x', allDay: false,
      dtstart: new Date('2026-01-05T17:00:00Z'), dtend: new Date('2026-01-05T18:00:00Z'),
      recurrence: {
        frequency: 'weekly', interval: 1, count: null, byday: null,
        until: new Date('2026-01-19'), exceptions: [new Date('2026-01-12')],
      },
    })
    expect(lineOf(ics, 'RRULE')).toBe('RRULE:FREQ=WEEKLY;UNTIL=20260119T225959Z')
    expect(lineOf(ics, 'EXDATE')).toBe('EXDATE;TZID=Europe/Berlin:20260112T180000')
  })

  it('all-day series: DATE until / exceptions keep their civil day (also from Berlin midnight)', () => {
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

  it('folds at 75 octets without splitting multi-byte characters', () => {
    const summary = 'Sitzung über Änderungen der Geschäftsordnung für Ausschüsse und Gremien – öffentlich'
    const ics = buildIcs({
      ...base, uid: 'u', summary, allDay: false,
      dtstart: new Date('2026-01-05T17:00:00Z'), dtend: new Date('2026-01-05T18:00:00Z'),
    })
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75)
    expect(lineOf(ics, 'SUMMARY')).toBe(`SUMMARY:${summary}`)
  })
})

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
