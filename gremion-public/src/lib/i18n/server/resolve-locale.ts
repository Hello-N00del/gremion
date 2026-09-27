// TASK-062 TDD 1/2 (gremion-public) — locale resolution (TRD-412/TRD-324).
//
// gremion-public has no session and no tenant/customer concept (app.d.ts:
// "No session — this app is fully public"), so its cascade is the tail of
// gremion-ui's: cookie -> Accept-Language -> 'de'. Kept as its own small
// copy rather than a cross-app import — the two apps are separate
// SvelteKit projects with no shared package between them.
//
// R26-TRAIN4-FIX r3: `available` narrows the cascade to the locales the pages
// are written in (locale.ts CONTENT_LOCALES), so a request never resolves to a
// language the page would only be labelled with (WCAG 3.1.1).

import { SUPPORTED_LOCALES, asSupportedLocale, type Locale } from '../locale'

export type { Locale }

export interface ResolveLocaleInput {
  cookie?: string | null
  acceptLanguage?: string | null
}

/**
 * Parses an Accept-Language header and returns the highest-quality match among
 * `available` by primary language subtag, or null if nothing recognized is
 * present. q=0 (RFC 9110 §12.4.2 "not acceptable") is skipped.
 */
function parseAcceptLanguage(header: string | null | undefined, asLocale: (value: string | undefined) => Locale | null): Locale | null {
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
    if (q <= 0) continue
    if (!best || q > best.q) best = { locale, q }
  }
  return best?.locale ?? null
}

/**
 * @param available the locales a request may resolve to; defaults to every
 * catalogue locale. 'de' is the terminal fallback either way.
 */
export function resolveLocale(input: ResolveLocaleInput, available: readonly Locale[] = SUPPORTED_LOCALES): Locale {
  const asLocale = (value: string | null | undefined): Locale | null => {
    const locale = asSupportedLocale(value)
    return locale && available.includes(locale) ? locale : null
  }

  const cookieLocale = asLocale(input.cookie ?? null)
  if (cookieLocale) return cookieLocale

  const acceptLanguageLocale = parseAcceptLanguage(input.acceptLanguage, asLocale)
  if (acceptLanguageLocale) return acceptLanguageLocale

  return 'de'
}
