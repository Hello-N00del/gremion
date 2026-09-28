// R26-TRAIN4-FIX (WCAG 2.2 SC 3.1.1 Language of Page, operator ruling
// 2026-09-27): `<html lang>` names the language the page is written in, not
// only the person's choice.
//
// Round 5: the rule fails safe. Most pages are still hard-coded German
// (TASK-161 migrates them), shell routes (/beschluesse, /protokolle,
// /systemstatus, ...) included, so a route is declared German unless its page
// is listed in TRANSLATED_ROUTE_IDS as rendering from the catalogue. A new
// route is German until someone translates it and adds it here;
// content-locale.test.ts scans every +page.svelte and fails when the list and
// the pages disagree in either direction. On a German page the catalogue
// strings around it (shell chrome, +error) render German too: the handle runs
// Paraglide in the content locale, and the root layout hands AppShell the same
// locale, so the whole document speaks one language.
//
// The decision is keyed by the SvelteKit route id (event.route.id on the
// server, navigation.to.route.id on the client), not by pathname prefix: a
// route id names exactly one page. A null route id (no route matched) renders
// +error, inside the (not yet translated) shell for a signed-in person, so it
// is German too. A document is declared in the person's locale only when
// everything it renders is translated: the page tree and, for a route inside
// the shell, the shell chrome.
//
// The person's locale still has to survive a German page: the client strategy
// (index.ts) reads it back from `<html lang>`, so a German page served to an
// English person carries it aside in `data-ui-locale`, and syncDocumentLang()
// (root +layout.svelte onNavigate/afterNavigate) restores it for the next page.
import { asSupportedLocale, type Locale } from './locale'

/**
 * Route ids whose pages are proven translated: their whole component tree
 * renders from the catalogue and carries no hard-coded text (content-locale.test.ts
 * checks this over every +page.svelte). Everything else is German. As of
 * 2026-09-27 the shell pages that use some catalogue strings (/, /members,
 * /members/committees/{new,[id]}, /settings/**) still carry hard-coded German
 * headings, titles and bodies, so they stay German until TASK-161 migrates
 * them and adds them here.
 */
export const TRANSLATED_ROUTE_IDS: ReadonlySet<string> = new Set(['/auth/login'])

/** Carries the person's locale on `<html>` while the page itself is declared in another language. */
export const UI_LOCALE_ATTRIBUTE = 'data-ui-locale'

/**
 * True when the page at `routeId` renders in the person's locale. A null route
 * id (no route matched) renders +error, which a signed-in person sees inside
 * the shell; the shell's TopBar and command palette still carry hard-coded
 * German, so that document is German too (content-locale.test.ts proves both).
 */
export function isTranslatedRoute(routeId: string | null | undefined): boolean {
  return routeId != null && TRANSLATED_ROUTE_IDS.has(routeId)
}

/** The language the page at `routeId` is written in, for a person whose locale is `uiLocale`. */
export function contentLocaleFor(routeId: string | null | undefined, uiLocale: Locale): Locale {
  return isTranslatedRoute(routeId) ? uiLocale : 'de'
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

/** The person's locale as the document carries it: data-ui-locale on a page declared in another language, else lang. */
export function uiLocaleOf(root: Pick<LangRoot, 'lang' | 'getAttribute'>): Locale {
  return asSupportedLocale(root.getAttribute(UI_LOCALE_ATTRIBUTE)) ?? asSupportedLocale(root.lang) ?? 'de'
}

/**
 * Client-side navigation keeps no server round trip for `<html>`, so the root
 * layout calls this before the next page renders (onNavigate) and again for
 * the page that actually landed (afterNavigate, after a redirect or a failed
 * navigation): `<html lang>` becomes that page's content language, and the
 * person's locale moves to or from `data-ui-locale`. Writes only what changes,
 * so a navigation that keeps the language causes no lang mutation.
 */
export function syncDocumentLang(root: LangRoot, routeId: string | null | undefined): void {
  const uiLocale = uiLocaleOf(root)
  const contentLocale = contentLocaleFor(routeId, uiLocale)
  if (contentLocale === uiLocale) {
    if (root.getAttribute(UI_LOCALE_ATTRIBUTE) !== null) root.removeAttribute(UI_LOCALE_ATTRIBUTE)
  } else if (root.getAttribute(UI_LOCALE_ATTRIBUTE) !== uiLocale) {
    root.setAttribute(UI_LOCALE_ATTRIBUTE, uiLocale)
  }
  if (root.lang !== contentLocale) root.lang = contentLocale
}
