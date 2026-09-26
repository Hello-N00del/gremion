// TASK-062 TDD 1 — the locale resolution order (TRD-412 / brief §5).
//
// Order: explicit de/en of the signed-in person -> cookie -> Accept-Language
// -> customer default_locale (this is where `follow_customer` resolves too)
// -> 'de'.
//
// The cookie step sits BEFORE Accept-Language and customer default even when
// the person's own preference is `follow_customer` (or the person is not
// signed in): per Q4, the cookie is the per-device mirror, so a device that
// already picked a language keeps it until something more specific (an
// explicit person preference) overrides it.

const SUPPORTED_LOCALES = ['de', 'en'] as const

export type Locale = (typeof SUPPORTED_LOCALES)[number]
export type PersonLocalePreference = Locale | 'follow_customer' | null | undefined

export interface ResolveLocaleInput {
  personPreference?: PersonLocalePreference
  cookie?: string | null
  acceptLanguage?: string | null
  customerDefaultLocale?: Locale | null
}

function asLocale(value: string | null | undefined): Locale | null {
  return value != null && (SUPPORTED_LOCALES as readonly string[]).includes(value) ? (value as Locale) : null
}

/**
 * Parses an Accept-Language header and returns the highest-quality
 * SUPPORTED_LOCALES match by primary language subtag (`en-US` matches `en`),
 * or null if nothing recognized is present. Malformed entries are skipped,
 * not thrown on; an empty/missing header yields null.
 */
function parseAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null
  let best: { locale: Locale; q: number } | null = null
  for (const part of header.split(',')) {
    const [rawTag, ...params] = part.trim().split(';')
    const tag = rawTag?.trim()
    if (!tag) continue
    const primary = tag.split('-')[0]?.toLowerCase()
    const locale = asLocale(primary)
    if (!locale) continue
    let q = 1
    for (const param of params) {
      const [k, v] = param.trim().split('=')
      if (k?.trim() === 'q' && v !== undefined) {
        const parsed = Number.parseFloat(v)
        if (Number.isFinite(parsed)) q = parsed
      }
    }
    if (!best || q > best.q) best = { locale, q }
  }
  return best?.locale ?? null
}

export function resolveLocale(input: ResolveLocaleInput): Locale {
  const explicitPerson = asLocale(input.personPreference ?? null)
  if (explicitPerson) return explicitPerson

  const cookieLocale = asLocale(input.cookie ?? null)
  if (cookieLocale) return cookieLocale

  const acceptLanguageLocale = parseAcceptLanguage(input.acceptLanguage)
  if (acceptLanguageLocale) return acceptLanguageLocale

  const customerDefault = asLocale(input.customerDefaultLocale ?? null)
  if (customerDefault) return customerDefault

  return 'de'
}
