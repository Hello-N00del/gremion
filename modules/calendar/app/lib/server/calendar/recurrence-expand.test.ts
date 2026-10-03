// F1-FIX-08 (S1c#12): recurring events vanished after their first occurrence —
// listEvents filtered on the stored first occurrence and nothing expanded the
// series for later windows. expandRecurringEvents turns each recurring master
// into its occurrences inside [from, to), on the Europe/Berlin wall clock.
import { describe, expect, it } from 'vitest'
import type { DbEvent, DbRecurrence } from './backend/port'
import { expandRecurringEvents } from './recurrence-expand'

function ev(over: Partial<DbEvent> & { startAt: Date; endAt: Date }, recurrence: DbRecurrence | null = null): DbEvent {
  return {
    id: 'ev-1',
    title: 'Plenum',
    description: null,
    location: null,
    allDay: false,
    eventTypeId: null,
    eventTypeColor: null,
    eventTypeName: null,
    isMultiCommittee: false,
    createdBy: 'u',
    source: 'manual',
    externalId: null,
    caldavUid: null,
    caldavSyncedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    committeeIds: [],
    colour: { primary: '#000', secondary: '#111' },
    readOnly: false,
    recurrence,
    ...over,
  }
}

const weekly = (over: Partial<DbRecurrence> = {}): DbRecurrence => ({
  frequency: 'weekly',
  interval: 1,
  until: null,
  count: null,
  byday: null,
  exceptions: null,
  ...over,
})

// Monday 2026-01-05 18:00 Europe/Berlin (CET, UTC+1) = 17:00Z, one hour long.
const MASTER_START = new Date('2026-01-05T17:00:00Z')
const MASTER_END = new Date('2026-01-05T18:00:00Z')
const iso = (events: DbEvent[]) => events.map((e) => e.startAt.toISOString())

describe('expandRecurringEvents (S1c#12)', () => {
  it('a weekly event created in January is returned in an April window, at 18:00 Berlin across DST', () => {
    const out = expandRecurringEvents(
      [ev({ startAt: MASTER_START, endAt: MASTER_END }, weekly())],
      new Date('2026-04-01T00:00:00Z'),
      new Date('2026-04-15T00:00:00Z'),
    )
    // CEST (UTC+2) after 2026-03-29 → 18:00 Berlin = 16:00Z.
    expect(iso(out)).toEqual(['2026-04-06T16:00:00.000Z', '2026-04-13T16:00:00.000Z'])
    expect(out.every((e) => e.endAt.getTime() - e.startAt.getTime() === 3_600_000)).toBe(true)
    expect(out.every((e) => e.id === 'ev-1')).toBe(true)
  })

  it('honours count (counted from the first occurrence, not from the window)', () => {
    const out = expandRecurringEvents(
      [ev({ startAt: MASTER_START, endAt: MASTER_END }, weekly({ count: 3 }))],
      new Date('2026-01-10T00:00:00Z'),
      new Date('2026-03-01T00:00:00Z'),
    )
    expect(iso(out)).toEqual(['2026-01-12T17:00:00.000Z', '2026-01-19T17:00:00.000Z'])
  })

  it('honours until (inclusive)', () => {
    const out = expandRecurringEvents(
      [ev({ startAt: MASTER_START, endAt: MASTER_END }, weekly({ until: new Date('2026-01-19T17:00:00Z') }))],
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-03-01T00:00:00Z'),
    )
    expect(iso(out)).toEqual([
      '2026-01-05T17:00:00.000Z',
      '2026-01-12T17:00:00.000Z',
      '2026-01-19T17:00:00.000Z',
    ])
  })

  // Round 2: event_recurrence.until / exceptions are DATE columns. postgres.js
  // returns them as UTC midnight (new Date('YYYY-MM-DD')); node-postgres under
  // TZ=Europe/Berlin as Berlin midnight. Both are a civil day, not an instant:
  // the meeting ON the end date must stay in the series.
  it('until as a DB DATE (UTC midnight) keeps the occurrence on that day; DATE exceptions still match', () => {
    const out = expandRecurringEvents(
      [
        ev(
          { startAt: MASTER_START, endAt: MASTER_END },
          weekly({ until: new Date('2026-01-19'), exceptions: [new Date('2026-01-12')] }),
        ),
      ],
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-03-01T00:00:00Z'),
    )
    expect(iso(out)).toEqual(['2026-01-05T17:00:00.000Z', '2026-01-19T17:00:00.000Z'])
  })

  it('until as Berlin midnight (node-postgres, TZ=Europe/Berlin) is the same civil day', () => {
    const out = expandRecurringEvents(
      [ev({ startAt: MASTER_START, endAt: MASTER_END }, weekly({ until: new Date('2026-01-18T23:00:00Z') }))],
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-03-01T00:00:00Z'),
    )
    expect(iso(out)).toEqual([
      '2026-01-05T17:00:00.000Z',
      '2026-01-12T17:00:00.000Z',
      '2026-01-19T17:00:00.000Z',
    ])
  })

  it('a series ends on its until day: nothing on the following day', () => {
    const daily: DbRecurrence = { ...weekly(), frequency: 'daily', until: new Date('2026-01-07') }
    const out = expandRecurringEvents(
      [ev({ startAt: MASTER_START, endAt: MASTER_END }, daily)],
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-03-01T00:00:00Z'),
    )
    expect(iso(out)).toEqual(['2026-01-05T17:00:00.000Z', '2026-01-06T17:00:00.000Z', '2026-01-07T17:00:00.000Z'])
  })

  it('skips exception dates', () => {
    const out = expandRecurringEvents(
      [ev({ startAt: MASTER_START, endAt: MASTER_END }, weekly({ exceptions: [new Date('2026-01-12T17:00:00Z')] }))],
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-20T00:00:00Z'),
    )
    expect(iso(out)).toEqual(['2026-01-05T17:00:00.000Z', '2026-01-19T17:00:00.000Z'])
  })

  it('weekly BYDAY expands every listed weekday', () => {
    const out = expandRecurringEvents(
      [ev({ startAt: MASTER_START, endAt: MASTER_END }, weekly({ byday: ['MO', 'WE'] }))],
      new Date('2026-01-12T00:00:00Z'),
      new Date('2026-01-19T00:00:00Z'),
    )
    expect(iso(out)).toEqual(['2026-01-12T17:00:00.000Z', '2026-01-14T17:00:00.000Z'])
  })

  it('monthly on the 31st skips months without a 31st', () => {
    const start = new Date('2026-01-31T09:00:00Z')
    const out = expandRecurringEvents(
      [ev({ startAt: start, endAt: new Date('2026-01-31T10:00:00Z') }, { ...weekly(), frequency: 'monthly' })],
      new Date('2026-02-01T00:00:00Z'),
      new Date('2026-04-01T00:00:00Z'),
    )
    expect(iso(out)).toEqual(['2026-03-31T08:00:00.000Z'])
  })

  it('interval 2 skips every other week', () => {
    const out = expandRecurringEvents(
      [ev({ startAt: MASTER_START, endAt: MASTER_END }, weekly({ interval: 2 }))],
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-02-01T00:00:00Z'),
    )
    expect(iso(out)).toEqual(['2026-01-05T17:00:00.000Z', '2026-01-19T17:00:00.000Z'])
  })

  it('passes non-recurring events through unchanged and drops masters with no occurrence in the window', () => {
    const single = ev({ id: 'single', startAt: new Date('2026-04-02T10:00:00Z'), endAt: new Date('2026-04-02T11:00:00Z') })
    const ended = ev(
      { id: 'ended', startAt: MASTER_START, endAt: MASTER_END },
      weekly({ until: new Date('2026-02-01T00:00:00Z') }),
    )
    const out = expandRecurringEvents([single, ended], new Date('2026-04-01T00:00:00Z'), new Date('2026-04-15T00:00:00Z'))
    expect(out.map((e) => e.id)).toEqual(['single'])
    expect(out[0]).toBe(single)
  })
})
