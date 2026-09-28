// TASK-062: locale vocabulary shared by the server cascade (server/**) and the
// browser shim (index.ts). Client-safe: no server imports.

/** BCP 47 tags rendered into `<html lang>` (TRD-324). German first (UX-015). */
export const SUPPORTED_LOCALES = ['de', 'en'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

/** The single Paraglide custom strategy that carries the whole cascade (see paraglide-options.js). */
export const GREMION_STRATEGY = 'custom-gremion'

/** Per-device mirror of the signed-in person's choice (brief §5 Q4). */
export const LOCALE_COOKIE = 'gremion.locale'

export function asSupportedLocale(value: unknown): Locale | null {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value) ? (value as Locale) : null
}
