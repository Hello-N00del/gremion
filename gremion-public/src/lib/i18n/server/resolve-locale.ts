// TASK-062 TDD 1/2 (gremion-public) — locale resolution (TRD-412/TRD-324).
//
// gremion-public has no session and no tenant/customer concept (app.d.ts:
// "No session — this app is fully public"), so its cascade is the tail of
// gremion-ui's: cookie -> Accept-Language -> 'de'. Kept as its own small
// copy rather than a cross-app import — the two apps are separate
// SvelteKit projects with no shared package between them.

const SUPPORTED_LOCALES = ['de', 'en'] as const

export type Locale = (typeof SUPPORTED_LOCALES)[number]

export interface ResolveLocaleInput {
  cookie?: string | null
  acceptLanguage?: string | null
}

function asLocale(value: string | null | undefined): Locale | null {
  return value != null && (SUPPORTED_LOCALES as readonly string[]).includes(value) ? (value as Locale) : null
}

/**
 * Parses an Accept-Language header and returns the highest-quality
 * SUPPORTED_LOCALES match by primary language subtag, or null if nothing
 * recognized is present. q=0 (RFC 9110 §12.4.2 "not acceptable") is skipped.
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
    if (q <= 0) continue
    if (!best || q > best.q) best = { locale, q }
  }
  return best?.locale ?? null
}

export function resolveLocale(input: ResolveLocaleInput): Locale {
  const cookieLocale = asLocale(input.cookie ?? null)
  if (cookieLocale) return cookieLocale

  const acceptLanguageLocale = parseAcceptLanguage(input.acceptLanguage)
  if (acceptLanguageLocale) return acceptLanguageLocale

  return 'de'
}
