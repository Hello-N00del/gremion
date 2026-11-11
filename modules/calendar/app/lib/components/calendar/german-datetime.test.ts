import { describe, expect, it } from 'vitest'
import {
  formatDateDe,
  formatLocalInputDe,
  parseDateDe,
  parseDateTimeDe,
  switchLocalKind,
} from './german-datetime'

describe('formatLocalInputDe', () => {
  it('writes the ISO local value in German order', () => {
    expect(formatLocalInputDe('2026-11-11T09:30')).toBe('11.11.2026 09:30')
    expect(formatLocalInputDe('2026-01-05T18:05')).toBe('05.01.2026 18:05')
  })
  it('writes nothing for an empty or broken value', () => {
    expect(formatLocalInputDe('')).toBe('')
    expect(formatLocalInputDe('nonsense')).toBe('')
    expect(formatLocalInputDe('2026-11-11')).toBe('')
  })
})

describe('formatDateDe', () => {
  it('writes an ISO date in German order', () => {
    expect(formatDateDe('2026-11-05')).toBe('05.11.2026')
  })
  it('writes nothing for an empty or broken value', () => {
    expect(formatDateDe('')).toBe('')
    expect(formatDateDe('05.11.2026')).toBe('')
  })
})

describe('parseDateTimeDe', () => {
  it('reads day.month.year hour:minute into the ISO local value', () => {
    expect(parseDateTimeDe('05.11.2026 09:30')).toBe('2026-11-05T09:30')
  })
  it('accepts single digits, extra blanks and a comma', () => {
    expect(parseDateTimeDe(' 5.1.2030,  7:05 ')).toBe('2030-01-05T07:05')
  })
  it('refuses the English order and the ISO form', () => {
    expect(parseDateTimeDe('2026-11-05T09:30')).toBeNull()
    expect(parseDateTimeDe('11/05/2026 09:30')).toBeNull()
  })
  it('refuses days, months and times that do not exist', () => {
    expect(parseDateTimeDe('31.02.2026 10:00')).toBeNull()
    expect(parseDateTimeDe('01.13.2026 10:00')).toBeNull()
    expect(parseDateTimeDe('01.01.2026 24:00')).toBeNull()
    expect(parseDateTimeDe('01.01.2026 10:60')).toBeNull()
  })
  it('refuses a date without a time', () => {
    expect(parseDateTimeDe('05.11.2026')).toBeNull()
  })
  it('round-trips with formatLocalInputDe', () => {
    expect(parseDateTimeDe(formatLocalInputDe('2031-12-24T18:45'))).toBe('2031-12-24T18:45')
  })
})

describe('parseDateDe', () => {
  it('reads day.month.year into the ISO date', () => {
    expect(parseDateDe('05.11.2026')).toBe('2026-11-05')
    expect(parseDateDe(' 5.1.2030 ')).toBe('2030-01-05')
  })
  it('refuses the English order, the ISO form and impossible days', () => {
    expect(parseDateDe('11/05/2026')).toBeNull()
    expect(parseDateDe('2026-11-05')).toBeNull()
    expect(parseDateDe('29.02.2027')).toBeNull()
    expect(parseDateDe('')).toBeNull()
  })
  it('round-trips with formatDateDe', () => {
    expect(parseDateDe(formatDateDe('2028-02-29'))).toBe('2028-02-29')
  })
})

describe('switchLocalKind', () => {
  it('cuts a date and time down to the date for an all-day event', () => {
    expect(switchLocalKind('2026-11-05T09:30', true)).toBe('2026-11-05')
  })
  it('gives a date a midnight time when the event stops being all-day', () => {
    expect(switchLocalKind('2026-11-05', false)).toBe('2026-11-05T00:00')
  })
  it('leaves a value that is already of the right kind, and an empty one', () => {
    expect(switchLocalKind('2026-11-05', true)).toBe('2026-11-05')
    expect(switchLocalKind('2026-11-05T09:30', false)).toBe('2026-11-05T09:30')
    expect(switchLocalKind('', true)).toBe('')
  })
})
