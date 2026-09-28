// TASK-062 TDD 9 (UX-017): dates and numbers follow the locale.
import { describe, expect, test } from 'vitest'
import { formatCurrency, formatDate, formatNumber } from './format'

// Intl puts a no-break space between amount and currency sign (correct: the
// two never wrap apart); compare on the visible text.
const visible = (s: string) => s.replace(/\u00a0|\u202f/g, ' ')
const day = new Date('2026-09-15T10:00:00Z')

describe('UX-017 locale formatting', () => {
  test('de: 15. September 2026 / 1.234,56 €', () => {
    expect(formatDate(day, 'de')).toBe('15. September 2026')
    expect(visible(formatCurrency(1234.56, 'de'))).toBe('1.234,56 €')
    expect(formatNumber(1234.56, 'de')).toBe('1.234,56')
  })

  test('en: 15 September 2026 / 1,234.56', () => {
    expect(formatDate(day, 'en')).toBe('15 September 2026')
    expect(formatNumber(1234.56, 'en')).toBe('1,234.56')
    expect(visible(formatCurrency(1234.56, 'en'))).toBe('€1,234.56')
  })

  test('dates are pinned to Europe/Berlin, so a late-evening UTC instant keeps its German calendar day', () => {
    expect(formatDate(new Date('2026-09-14T22:30:00Z'), 'de')).toBe('15. September 2026')
  })

  test('accepts ISO strings as well as Date instances', () => {
    expect(formatDate('2026-09-15', 'en')).toBe('15 September 2026')
  })
})
