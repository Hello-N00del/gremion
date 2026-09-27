// TASK-062 TDD 2 (gremion-public, brief §6.2/TRD-412/TRD-324).
//
// gremion-public has no session (app.d.ts), so this is the cookie ->
// Accept-Language -> 'de' tail of gremion-ui's cascade: no person preference,
// no customer default. The cookie is the one gremion-ui's switch sets
// (Path=/), so a portal served on the same origin follows the person's choice
// once the portal is written in that language.
//
// R26-TRAIN4-FIX r3 (WCAG 3.1.1): the cascade only chooses among the locales
// the portal's pages are written in (locale.ts CONTENT_LOCALES, 'de' alone
// until TASK-161 translates them), so an en-US visitor gets lang="de" on the
// German pages rather than lang="en" on German text.
//
// Same shape as gremion-ui's handle: the resolved locale reaches Paraglide's
// per-request AsyncLocalStorage through the `custom-gremion` server strategy,
// resolve() runs inside paraglideMiddleware, and transformPageChunk fills
// app.html's `%paraglide.lang%`, so the raw response carries the right
// `<html lang>` before any client script runs (curl-testable).
import type { Handle } from '@sveltejs/kit'
import { resolveLocale, type Locale } from './resolve-locale'
import { CONTENT_LOCALES, GREMION_STRATEGY, LOCALE_COOKIE } from '../locale'
import { paraglideMiddleware } from '../paraglide/server.js'
import { defineCustomServerStrategy } from '../paraglide/runtime.js'

export { LOCALE_COOKIE }

/** The placeholder app.html carries in `<html lang="…">`. */
export const LANG_PLACEHOLDER = '%paraglide.lang%'

type MinimalRequestEvent = {
  url: URL
  cookies: { get(name: string): string | undefined }
  request: { headers: { get(name: string): string | null } }
  locals: Record<string, unknown>
}

const resolvedLocales = new WeakMap<Request, Locale>()
defineCustomServerStrategy(GREMION_STRATEGY, {
  getLocale: (request) => (request ? resolvedLocales.get(request) : undefined)
})

export interface I18nHandleOptions {
  /** The locales a request may resolve to. Defaults to CONTENT_LOCALES. */
  contentLocales?: readonly Locale[]
}

export function createI18nHandle(options: I18nHandleOptions = {}): Handle {
  const contentLocales = options.contentLocales ?? CONTENT_LOCALES
  const handle: Handle = async ({ event, resolve }) => {
    const e = event as unknown as MinimalRequestEvent
    // Optional chaining: guards an incomplete synthetic RequestEvent in a
    // test double, not a real production path (a real RequestEvent always
    // has both).
    const cookie = e.cookies?.get(LOCALE_COOKIE) ?? null
    const acceptLanguage = e.request?.headers?.get('accept-language') ?? null
    const locale: Locale = resolveLocale({ cookie, acceptLanguage }, contentLocales)
    ;(e.locals as { locale?: Locale }).locale = locale

    // Body-less stand-in: Paraglide clones the Request it is given.
    const probe = new Request(e.url)
    resolvedLocales.set(probe, locale)

    return paraglideMiddleware(probe, ({ locale: requestLocale }) =>
      resolve(event, {
        transformPageChunk: ({ html }) => html.replace(LANG_PLACEHOLDER, requestLocale)
      })
    )
  }
  return handle
}
