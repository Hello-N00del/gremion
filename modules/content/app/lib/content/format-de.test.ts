import { describe, expect, it } from 'vitest'
import { countLabel, formatLocalInputDe, parseDateTimeDe } from './format-de'

describe('formatLocalInputDe', () => {
  it('writes the ISO local value in German order', () => {
    expect(formatLocalInputDe('2026-11-05T09:30')).toBe('05.11.2026 09:30')
  })
  it('writes nothing for an empty or broken value', () => {
    expect(formatLocalInputDe('')).toBe('')
    expect(formatLocalInputDe('nonsense')).toBe('')
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

describe('countLabel', () => {
  it('uses the singular for exactly 1', () => {
    expect(countLabel(1, 'Mitglied', 'Mitglieder')).toBe('1 Mitglied')
  })
  it('uses the plural for 0 and for 2 or more', () => {
    expect(countLabel(0, 'Mitglied', 'Mitglieder')).toBe('0 Mitglieder')
    expect(countLabel(2, 'Mitglied', 'Mitglieder')).toBe('2 Mitglieder')
  })
})
