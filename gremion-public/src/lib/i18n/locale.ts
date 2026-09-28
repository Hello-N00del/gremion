// TASK-062: locale vocabulary for the portal, the same values as gremion-ui's
// src/lib/i18n/locale.ts (the two apps share no package).

/** BCP 47 tags rendered into `<html lang>` (TRD-324). German first (UX-015). */
export const SUPPORTED_LOCALES = ['de', 'en'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

/**
 * The locales the portal's pages are actually written in. `<html lang>` must
 * name the language the page renders (WCAG 3.1.1), and every visible portal
 * string is still hard-coded German: the catalogue in messages/*.json covers
 * no rendered page yet. So the portal neither offers nor applies 'en', whatever
 * the cookie or Accept-Language asks for (R26-TRAIN4-FIX r3, operator ruling
 * 2026-09-27). TASK-161 adds 'en' here in the change that translates the
 * portal's pages; i18n-handle.test.ts fails if 'en' returns before that.
 */
export const CONTENT_LOCALES: readonly Locale[] = ['de']

/** The single Paraglide custom strategy that carries the whole cascade (see paraglide-options.js). */
export const GREMION_STRATEGY = 'custom-gremion'

/** Per-device mirror of the signed-in person's choice (brief §5 Q4). */
export const LOCALE_COOKIE = 'gremion.locale'

export function asSupportedLocale(value: unknown): Locale | null {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value) ? (value as Locale) : null
}
