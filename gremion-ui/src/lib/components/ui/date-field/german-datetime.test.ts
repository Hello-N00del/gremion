import { describe, it, expect } from 'vitest'
import { formatDateDe, formatLocalInputDe, parseDateDe, parseDateTimeDe } from './german-datetime'

describe('formatDateDe', () => {
  it('shows an ISO date in German order', () => {
    expect(formatDateDe('2026-11-05')).toBe('05.11.2026')
  })
  it('is empty for anything that is not an ISO date', () => {
    expect(formatDateDe('')).toBe('')
    expect(formatDateDe('05.11.2026')).toBe('')
    expect(formatDateDe('2026-11-05T09:30')).toBe('')
  })
})

describe('parseDateDe', () => {
  it('reads German order into an ISO date, with or without leading zeros', () => {
    expect(parseDateDe('05.11.2026')).toBe('2026-11-05')
    expect(parseDateDe(' 5.1.2030 ')).toBe('2030-01-05')
  })
  it('refuses other orders and days that do not exist', () => {
    expect(parseDateDe('11/05/2026')).toBeNull()
    expect(parseDateDe('2026-11-05')).toBeNull()
    expect(parseDateDe('29.02.2027')).toBeNull()
    expect(parseDateDe('31.04.2026')).toBeNull()
    expect(parseDateDe('01.13.2026')).toBeNull()
    expect(parseDateDe('05.11.26')).toBeNull()
    expect(parseDateDe('')).toBeNull()
  })
  it('refuses a year below 1000: the ISO value would not have four digits', () => {
    expect(parseDateDe('01.01.0999')).toBeNull()
    expect(parseDateDe('01.01.0099')).toBeNull()
    expect(parseDateDe('01.01.0000')).toBeNull()
    expect(parseDateDe('01.01.1000')).toBe('1000-01-01')
  })
  it('round-trips with formatDateDe', () => {
    expect(parseDateDe(formatDateDe('2028-02-29'))).toBe('2028-02-29')
  })
})

describe('formatLocalInputDe', () => {
  it('shows an ISO local date and time in German order', () => {
    expect(formatLocalInputDe('2026-11-05T09:30')).toBe('05.11.2026 09:30')
  })
  it('is empty for anything that is not an ISO local date and time', () => {
    expect(formatLocalInputDe('')).toBe('')
    expect(formatLocalInputDe('2026-11-05')).toBe('')
  })
})

describe('parseDateTimeDe', () => {
  it('reads German order into an ISO local value', () => {
    expect(parseDateTimeDe('05.11.2026 09:30')).toBe('2026-11-05T09:30')
    expect(parseDateTimeDe(' 5.1.2030,  7:05 ')).toBe('2030-01-05T07:05')
  })
  it('refuses other orders, impossible days and times, and a missing time', () => {
    expect(parseDateTimeDe('2026-11-05T09:30')).toBeNull()
    expect(parseDateTimeDe('11/05/2026 09:30')).toBeNull()
    expect(parseDateTimeDe('31.02.2026 10:00')).toBeNull()
    expect(parseDateTimeDe('01.01.2026 24:00')).toBeNull()
    expect(parseDateTimeDe('01.01.2026 10:60')).toBeNull()
    expect(parseDateTimeDe('05.11.2026')).toBeNull()
  })
  it('refuses a year below 1000: the ISO value would not have four digits', () => {
    expect(parseDateTimeDe('01.01.0999 10:00')).toBeNull()
    expect(parseDateTimeDe('01.01.0099 10:00')).toBeNull()
    expect(parseDateTimeDe('01.01.1000 10:00')).toBe('1000-01-01T10:00')
  })
  it('round-trips with formatLocalInputDe', () => {
    expect(parseDateTimeDe(formatLocalInputDe('2031-12-24T18:45'))).toBe('2031-12-24T18:45')
  })
})
