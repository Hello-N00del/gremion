// TASK-062 TDD 2 (gremion-public, brief §6.2/TRD-412/TRD-324).
//
// gremion-public has no session (app.d.ts), so this is the cookie ->
// Accept-Language -> 'de' tail of gremion-ui's cascade: no person preference,
// no customer default. The cookie is the one gremion-ui's switch sets
// (Path=/), so a portal served on the same origin follows the person's choice.
//
// Same shape as gremion-ui's handle: the resolved locale reaches Paraglide's
// per-request AsyncLocalStorage through the `custom-gremion` server strategy,
// resolve() runs inside paraglideMiddleware, and transformPageChunk fills
// app.html's `%paraglide.lang%`, so the raw response carries the right
// `<html lang>` before any client script runs (curl-testable).
import type { Handle } from '@sveltejs/kit'
import { resolveLocale, type Locale } from './resolve-locale'
import { GREMION_STRATEGY, LOCALE_COOKIE } from '../locale'
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

export function createI18nHandle(): Handle {
  const handle: Handle = async ({ event, resolve }) => {
    const e = event as unknown as MinimalRequestEvent
    // Optional chaining: guards an incomplete synthetic RequestEvent in a
    // test double, not a real production path (a real RequestEvent always
    // has both).
    const cookie = e.cookies?.get(LOCALE_COOKIE) ?? null
    const acceptLanguage = e.request?.headers?.get('accept-language') ?? null
    const locale: Locale = resolveLocale({ cookie, acceptLanguage })
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
