import { describe, test, expect } from 'vitest'
import { dueState, isOverdue } from './due'

// Fixed "today" so the relative-day buckets are deterministic in CI.
const TODAY = new Date('2026-06-02T00:00:00')

describe('dueState', () => {
  test('null / undefined / empty → no badge', () => {
    expect(dueState(null, { today: TODAY })).toBeNull()
    expect(dueState(undefined, { today: TODAY })).toBeNull()
    expect(dueState('', { today: TODAY })).toBeNull()
  })

  test('garbage never renders "Invalid Date"', () => {
    expect(dueState('not-a-date', { today: TODAY })).toBeNull()
    const r = dueState('2026-13-99', { today: TODAY })
    // Either null or a label — but NEVER the literal "Invalid Date".
    expect(r?.label ?? '').not.toContain('Invalid')
  })

  test('a full ISO timestamp is tolerated (the live "Invalid Date" bug)', () => {
    // The loader used to pass a full timestamp straight through; the old
    // `new Date(due + "T00:00:00")` then produced "Invalid Date".
    const r = dueState('2026-06-08T14:30:00.000Z', { today: TODAY })
    expect(r).not.toBeNull()
    expect(r!.label).not.toContain('Invalid')
    // German toLocaleDateString yields a trailing dot ("08.06.") — faithful to
    // the v6 prototype's identical formatter. 6 days out → soon window.
    expect(r).toEqual({ label: '08.06.', cls: 'soon' })
  })

  test('overdue → "Überfällig · DD.MM.", cls=over', () => {
    const r = dueState('2026-05-28', { today: TODAY })
    expect(r).toEqual({ label: 'Überfällig · 28.05.', cls: 'over' })
  })

  test('today → "Heute", cls=soon', () => {
    expect(dueState('2026-06-02', { today: TODAY })).toEqual({ label: 'Heute', cls: 'soon' })
  })

  test('within a week → DD.MM., cls=soon', () => {
    expect(dueState('2026-06-05', { today: TODAY })).toEqual({ label: '05.06.', cls: 'soon' })
  })

  test('more than a week out → DD.MM., no urgency class', () => {
    expect(dueState('2026-07-01', { today: TODAY })).toEqual({ label: '01.07.', cls: '' })
  })

  test('done card → "Erledigt" regardless of due_date', () => {
    expect(dueState('2026-05-01', { done: true, today: TODAY })).toEqual({ label: 'Erledigt', cls: 'done' })
    expect(dueState(null, { done: true, today: TODAY })).toEqual({ label: 'Erledigt', cls: 'done' })
  })
})

describe('isOverdue', () => {
  test('past date is overdue, future is not', () => {
    expect(isOverdue('2026-05-01', TODAY)).toBe(true)
    expect(isOverdue('2026-12-01', TODAY)).toBe(false)
    expect(isOverdue(null, TODAY)).toBe(false)
  })
})
