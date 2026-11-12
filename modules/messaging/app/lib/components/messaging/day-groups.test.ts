// Day grouping of a conversation. Every case names its zone explicitly, so the result does not
// depend on the zone of the machine that runs it.
import { describe, expect, it } from 'vitest'
import { groupByDay } from './day-groups'

const BERLIN = 'Europe/Berlin'

interface Msg {
  id: string
  ts?: number | null
}
const at = (id: string, iso: string): Msg => ({ id, ts: Date.parse(iso) })

/** Groups as "label: ids", the shape a reader sees. */
function shape(messages: Msg[], nowIso: string, timeZone: string = BERLIN): string[] {
  return groupByDay(messages, new Date(nowIso), timeZone).map(
    (g) => `${g.label ?? '(kein Tag)'}: ${g.messages.map((m) => m.id).join(',')}`,
  )
}

describe('groupByDay', () => {
  it('splits at local midnight, not at the UTC date change', () => {
    const messages = [
      at('a', '2026-11-10T22:30:00Z'), // 10.11. 23:30 Berlin
      at('b', '2026-11-10T23:30:00Z'), // 11.11. 00:30 Berlin, same UTC date as a
      at('c', '2026-11-11T22:59:00Z'), // 11.11. 23:59 Berlin
      at('d', '2026-11-11T23:01:00Z'), // 12.11. 00:01 Berlin, same UTC date as c
    ]
    expect(shape(messages, '2026-11-12T08:00:00Z')).toEqual([
      '10.11.2026: a',
      'Gestern · 11.11.2026: b,c',
      'Heute · 12.11.2026: d',
    ])
  })

  it('labels a group with its own day: no "Heute" when nothing was sent today', () => {
    const messages = [at('a', '2026-11-11T09:00:00Z'), at('b', '2026-11-11T15:00:00Z')]
    expect(shape(messages, '2026-11-12T08:00:00Z')).toEqual(['Gestern · 11.11.2026: a,b'])
    expect(shape(messages, '2026-11-13T08:00:00Z')).toEqual(['11.11.2026: a,b'])
    expect(shape(messages, '2026-11-11T20:00:00Z')).toEqual(['Heute · 11.11.2026: a,b'])
  })

  it('uses the zone it is given: the same instants fall on other days elsewhere', () => {
    const messages = [at('a', '2026-11-11T22:30:00Z'), at('b', '2026-11-11T23:30:00Z')]
    const now = '2026-11-12T08:00:00Z'
    expect(shape(messages, now, BERLIN)).toEqual(['Gestern · 11.11.2026: a', 'Heute · 12.11.2026: b'])
    expect(shape(messages, now, 'UTC')).toEqual(['Gestern · 11.11.2026: a,b'])
    // 08:00 UTC is 03:00 in New York: still the 12th there, both messages are from the evening before.
    expect(shape(messages, now, 'America/New_York')).toEqual(['Gestern · 11.11.2026: a,b'])
  })

  it('"Gestern" is the calendar day before today, also across the 23-hour day of the clock change', () => {
    // Berlin switches to summer time on 29.03.2026. "Now" is 30.03. 00:30; 24 hours earlier it was
    // still 28.03. on the clock, yet yesterday is the 29th.
    const messages = [
      at('a', '2026-03-28T22:30:00Z'), // 28.03. 23:30 (winter time)
      at('b', '2026-03-29T10:00:00Z'), // 29.03. 12:00 (summer time)
      at('c', '2026-03-29T22:10:00Z'), // 30.03. 00:10 (summer time)
    ]
    expect(shape(messages, '2026-03-29T22:30:00Z')).toEqual([
      '28.03.2026: a',
      'Gestern · 29.03.2026: b',
      'Heute · 30.03.2026: c',
    ])
  })

  it('"Gestern" crosses month and year ends', () => {
    expect(shape([at('a', '2026-12-31T12:00:00Z')], '2027-01-01T12:00:00Z')).toEqual(['Gestern · 31.12.2026: a'])
    expect(shape([at('a', '2026-02-28T12:00:00Z')], '2026-03-01T12:00:00Z')).toEqual(['Gestern · 28.02.2026: a'])
  })

  it('writes day and month with two digits', () => {
    expect(shape([at('a', '2026-03-05T12:00:00Z')], '2026-11-12T08:00:00Z')).toEqual(['05.03.2026: a'])
  })

  it('keeps a message without a usable timestamp in the group it follows', () => {
    const messages: Msg[] = [
      at('a', '2026-11-11T09:00:00Z'),
      { id: 'zero', ts: 0 },
      { id: 'missing' },
      { id: 'null', ts: null },
      { id: 'nan', ts: Number.NaN },
      at('b', '2026-11-12T07:00:00Z'),
    ]
    expect(shape(messages, '2026-11-12T08:00:00Z')).toEqual([
      'Gestern · 11.11.2026: a,zero,missing,null,nan',
      'Heute · 12.11.2026: b',
    ])
  })

  it('gives leading messages without a timestamp a group that has no separator', () => {
    const messages: Msg[] = [{ id: 'x', ts: 0 }, at('a', '2026-11-12T07:00:00Z')]
    const groups = groupByDay(messages, new Date('2026-11-12T08:00:00Z'), BERLIN)
    expect(groups.map((g) => [g.day, g.label])).toEqual([
      [null, null],
      ['2026-11-12', 'Heute · 12.11.2026'],
    ])
  })

  it('keeps the order it is given and never merges separated runs', () => {
    // A late-delivered older message between two messages of today: three runs, order untouched.
    const messages = [
      at('a', '2026-11-12T06:00:00Z'),
      at('late', '2026-11-11T09:00:00Z'),
      at('b', '2026-11-12T07:00:00Z'),
    ]
    expect(shape(messages, '2026-11-12T08:00:00Z')).toEqual([
      'Heute · 12.11.2026: a',
      'Gestern · 11.11.2026: late',
      'Heute · 12.11.2026: b',
    ])
  })

  it('returns no group for an empty conversation', () => {
    expect(groupByDay([], new Date('2026-11-12T08:00:00Z'), BERLIN)).toEqual([])
  })
})
