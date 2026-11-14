import { describe, expect, it } from 'vitest'
import { formatDateDe, parseDateDe } from './german-date'

describe('the German date of a card', () => {
  it('shows an ISO day in German order', () => {
    expect(formatDateDe('2026-12-01')).toBe('01.12.2026')
  })

  it('shows nothing for no date and for anything that is not an ISO day', () => {
    expect(formatDateDe('')).toBe('')
    expect(formatDateDe('12/01/2026')).toBe('')
    expect(formatDateDe('2026-12-01T10:00')).toBe('')
  })

  it('reads German order back into the ISO day, with or without leading zeros', () => {
    expect(parseDateDe('15.12.2026')).toBe('2026-12-15')
    expect(parseDateDe(' 5.1.2027 ')).toBe('2027-01-05')
  })

  it('refuses a day that does not exist and any other order', () => {
    expect(parseDateDe('31.02.2026')).toBeNull()
    expect(parseDateDe('00.01.2026')).toBeNull()
    expect(parseDateDe('12/15/2026')).toBeNull()
    expect(parseDateDe('2026-12-15')).toBeNull()
    expect(parseDateDe('15.12.26')).toBeNull()
    expect(parseDateDe('')).toBeNull()
  })

  it('never reads month-first: 03.04. is the third of April', () => {
    expect(parseDateDe('03.04.2026')).toBe('2026-04-03')
  })
})
