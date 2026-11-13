import { describe, expect, it } from 'vitest'
import { isTermMonths, semesterLabel } from './semester'

// W = winter semester start month, S = summer semester start month.
const DE = { winter: 10, summer: 4 }

describe('semesterLabel (W=10, S=4)', () => {
  const cases: Array<[string, string]> = [
    ['2026-11-13T12:00:00Z', 'WiSe 26/27'],
    ['2027-01-15T12:00:00Z', 'WiSe 26/27'],
    ['2027-03-31T12:00:00Z', 'WiSe 26/27'],
    ['2027-04-01T12:00:00Z', 'SoSe 27'],
    ['2027-09-30T12:00:00Z', 'SoSe 27'],
    ['2027-10-01T12:00:00Z', 'WiSe 27/28'],
    ['2026-12-31T12:00:00Z', 'WiSe 26/27'],
    ['2027-01-01T12:00:00Z', 'WiSe 26/27'],
  ]
  for (const [iso, want] of cases) {
    it(`${iso.slice(0, 10)} -> ${want}`, () => {
      expect(semesterLabel(new Date(iso), DE)).toBe(want)
    })
  }

  it('prints the century rollover as 99/00 and 00/01', () => {
    expect(semesterLabel(new Date('2099-11-01T12:00:00Z'), DE)).toBe('WiSe 99/00')
    expect(semesterLabel(new Date('2100-01-10T12:00:00Z'), DE)).toBe('WiSe 99/00')
    expect(semesterLabel(new Date('2100-05-01T12:00:00Z'), DE)).toBe('SoSe 00')
    expect(semesterLabel(new Date('2100-10-01T12:00:00Z'), DE)).toBe('WiSe 00/01')
  })

  it('reads the calendar month in Europe/Berlin, not UTC', () => {
    // 2027-03-31 22:30 UTC is already 1 April 00:30 in Berlin (CEST, UTC+2)
    expect(semesterLabel(new Date('2027-03-31T22:30:00Z'), DE)).toBe('SoSe 27')
    // 2027-09-30 22:30 UTC is already 1 October in Berlin
    expect(semesterLabel(new Date('2027-09-30T22:30:00Z'), DE)).toBe('WiSe 27/28')
    // 2026-12-31 23:30 UTC is already 1 January 2027 in Berlin (CET, UTC+1): same semester, still the 26/27 one
    expect(semesterLabel(new Date('2026-12-31T23:30:00Z'), DE)).toBe('WiSe 26/27')
  })

  it('switches exactly at the Berlin midnight of the start month', () => {
    // 1 April 2027 00:00 Berlin = 31 March 22:00 UTC
    expect(semesterLabel(new Date('2027-03-31T21:59:59Z'), DE)).toBe('WiSe 26/27')
    expect(semesterLabel(new Date('2027-03-31T22:00:00Z'), DE)).toBe('SoSe 27')
  })
})

describe('semesterLabel (other start months)', () => {
  it('works for a summer semester that starts in March and a winter one in September', () => {
    const m = { winter: 9, summer: 3 }
    expect(semesterLabel(new Date('2027-02-28T12:00:00Z'), m)).toBe('WiSe 26/27')
    expect(semesterLabel(new Date('2027-03-01T12:00:00Z'), m)).toBe('SoSe 27')
    expect(semesterLabel(new Date('2027-08-31T12:00:00Z'), m)).toBe('SoSe 27')
    expect(semesterLabel(new Date('2027-09-01T12:00:00Z'), m)).toBe('WiSe 27/28')
  })

  it('works when the winter semester starts before the summer one (W < S): the half-open ranges wrap the year', () => {
    // winter Mar..Aug, summer Sep..Feb; a semester is named for the year it STARTED in
    const m = { winter: 3, summer: 9 }
    expect(semesterLabel(new Date('2026-03-01T12:00:00Z'), m)).toBe('WiSe 26/27')
    expect(semesterLabel(new Date('2026-08-31T12:00:00Z'), m)).toBe('WiSe 26/27')
    expect(semesterLabel(new Date('2026-09-01T12:00:00Z'), m)).toBe('SoSe 26')
    expect(semesterLabel(new Date('2026-12-15T12:00:00Z'), m)).toBe('SoSe 26')
    expect(semesterLabel(new Date('2027-01-15T12:00:00Z'), m)).toBe('SoSe 26')
    expect(semesterLabel(new Date('2027-02-28T12:00:00Z'), m)).toBe('SoSe 26')
    expect(semesterLabel(new Date('2027-03-01T12:00:00Z'), m)).toBe('WiSe 27/28')
  })

  it('covers every month of a year with exactly one label (W=10, S=4)', () => {
    const labels = Array.from({ length: 12 }, (_, i) => semesterLabel(new Date(Date.UTC(2027, i, 15, 12)), DE))
    expect(labels).toEqual([
      'WiSe 26/27', 'WiSe 26/27', 'WiSe 26/27',
      'SoSe 27', 'SoSe 27', 'SoSe 27', 'SoSe 27', 'SoSe 27', 'SoSe 27',
      'WiSe 27/28', 'WiSe 27/28', 'WiSe 27/28',
    ])
  })
})

describe('isTermMonths', () => {
  it('accepts two different integer months 1 to 12', () => {
    expect(isTermMonths({ winter: 10, summer: 4 })).toBe(true)
    expect(isTermMonths({ winter: 1, summer: 12 })).toBe(true)
  })
  it('refuses equal, out-of-range, non-integer and malformed values', () => {
    expect(isTermMonths({ winter: 4, summer: 4 })).toBe(false)
    expect(isTermMonths({ winter: 0, summer: 4 })).toBe(false)
    expect(isTermMonths({ winter: 10, summer: 13 })).toBe(false)
    expect(isTermMonths({ winter: 10.5, summer: 4 })).toBe(false)
    expect(isTermMonths({ winter: '10', summer: 4 })).toBe(false)
    expect(isTermMonths({ winter: 10 })).toBe(false)
    expect(isTermMonths(null)).toBe(false)
    expect(isTermMonths('10/4')).toBe(false)
  })
})
