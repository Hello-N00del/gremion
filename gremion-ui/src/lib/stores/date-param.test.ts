import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseDateParam } from './date-param'

// The command palette links an event as /calendar?date=YYYY-MM-DD: the calendar opens on that day.
describe('calendar ?date= parameter', () => {
  test('a valid day becomes that calendar day (local noon, so no time zone moves it to a neighbour)', () => {
    const d = parseDateParam('2026-12-03')!
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 11, 3, 12])
  })

  test('anything else is ignored', () => {
    for (const v of [null, '', 'abc', '2026-13-01', '2026-02-30', '2026-12-3', '26-12-03', '2026-12-03T10:00', ' 2026-12-03', '2026-12-03 ']) {
      expect(parseDateParam(v), String(v)).toBeNull()
    }
  })

  test('the page applies it on mount, before it loads the first range', () => {
    const src = readFileSync(join(__dirname, '../../routes/calendar/+page.svelte'), 'utf8')
    const apply = src.indexOf("parseDateParam(url.searchParams.get('date'))")
    const load = src.indexOf('visibleRange.subscribe')
    expect(apply).toBeGreaterThan(-1)
    expect(apply).toBeLessThan(load)
    expect(src).toContain('calendarDate.set(')
  })
})
