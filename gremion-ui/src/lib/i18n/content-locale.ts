// R26-TRAIN4-FIX r3 (WCAG 3.1.1, operator ruling 2026-09-27): `<html lang>`
// names the language the page is written in, not only the person's choice.
//
// Every route inside the app shell renders its chrome (AppShell, NavDrawer,
// TopBar) and +error from the catalogue, so those keep the person's locale.
// The routes below sit outside the shell (root +layout.svelte isShellRoute)
// and render no catalogue string: their text is German whatever the locale,
// so they are declared German and render any catalogue string (+error) in
// German too. TASK-161 removes a prefix in the change that translates its
// pages; content-locale.test.ts fails if the list and the routes disagree.
//
// The person's locale still has to survive a German-only page: the client
// strategy (index.ts) reads it back from `<html lang>`, so a German-only page
// served to an English person carries it aside in `data-ui-locale`, and
// syncDocumentLang() (root +layout.svelte onNavigate) restores it before the
// next client-side page renders.
import { asSupportedLocale, type Locale } from './locale'

/** Non-shell routes whose pages render German-only text (no catalogue string). */
export const GERMAN_ONLY_ROUTE_PREFIXES = ['/legal', '/setup', '/auth/step-up', '/auth/logout'] as const

/** Carries the person's locale on `<html>` while the page itself is declared in another language. */
export const UI_LOCALE_ATTRIBUTE = 'data-ui-locale'

/** Segment-boundary match: '/legal' covers '/legal/impressum', never '/legalese'. */
export function isGermanOnlyPath(pathname: string): boolean {
  return GERMAN_ONLY_ROUTE_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

/** The language a page at `pathname` is written in, for a person whose locale is `uiLocale`. */
export function contentLocaleFor(pathname: string, uiLocale: Locale): Locale {
  return isGermanOnlyPath(pathname) ? 'de' : uiLocale
}

/** The `<html>` attributes the server renders: the content language, plus the person's locale where it differs. */
export function htmlLangAttributes(contentLocale: Locale, uiLocale: Locale): string {
  return contentLocale === uiLocale ? `lang="${contentLocale}"` : `lang="${contentLocale}" ${UI_LOCALE_ATTRIBUTE}="${uiLocale}"`
}

export interface LangRoot {
  lang: string
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

/**
 * Client-side navigation keeps no server round trip for `<html>`, so the root
 * layout calls this before the next page renders: `<html lang>` becomes the
 * next page's content language, and the person's locale moves to or from
 * `data-ui-locale`. Writes only what changes, so a navigation that keeps the
 * language causes no lang mutation.
 */
export function syncDocumentLang(root: LangRoot, pathname: string): void {
  const uiLocale = asSupportedLocale(root.getAttribute(UI_LOCALE_ATTRIBUTE)) ?? asSupportedLocale(root.lang) ?? 'de'
  const contentLocale = contentLocaleFor(pathname, uiLocale)
  if (contentLocale === uiLocale) {
    if (root.getAttribute(UI_LOCALE_ATTRIBUTE) !== null) root.removeAttribute(UI_LOCALE_ATTRIBUTE)
  } else if (root.getAttribute(UI_LOCALE_ATTRIBUTE) !== uiLocale) {
    root.setAttribute(UI_LOCALE_ATTRIBUTE, uiLocale)
  }
  if (root.lang !== contentLocale) root.lang = contentLocale
}
