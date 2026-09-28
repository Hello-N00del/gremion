// TASK-062 (UX-017): locale-aware dates and numbers.
//   de: 15. September 2026 / 1.234,56 €
//   en: 15 September 2026  / 1,234.56 (€1,234.56 as currency)
// `en` formats as en-GB (day-month-year, as UX-017's example); `<html lang>`
// stays the bare BCP 47 `en` (TRD-324). Dates are pinned to Europe/Berlin so a
// server in UTC and a browser in Berlin print the same calendar day.
import type { Locale } from './locale'

const INTL_TAG: Record<Locale, string> = { de: 'de-DE', en: 'en-GB' }
const TIME_ZONE = 'Europe/Berlin'

export function formatDate(value: Date | string | number, locale: Locale): string {
  const date = value instanceof Date ? value : new Date(value)
  return new Intl.DateTimeFormat(INTL_TAG[locale], {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: TIME_ZONE
  }).format(date)
}

export function formatNumber(value: number, locale: Locale, fractionDigits = 2): string {
  return new Intl.NumberFormat(INTL_TAG[locale], {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  }).format(value)
}

export function formatCurrency(value: number, locale: Locale, currency = 'EUR'): string {
  return new Intl.NumberFormat(INTL_TAG[locale], { style: 'currency', currency }).format(value)
}
