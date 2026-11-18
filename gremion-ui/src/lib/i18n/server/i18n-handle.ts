// TASK-062 TDD 2/7 — i18nHandle (brief §6.2/6.7, TRD-412/TRD-324).
//
// 1. resolveRequestLocale() runs the cascade (resolve-locale.ts): explicit
//    person preference -> cookie -> Accept-Language -> customer default -> 'de'.
// 2. paraglideMiddleware() puts that locale into Paraglide's per-request
//    AsyncLocalStorage, so every message function and the legacy `$t` shim
//    render in it during SSR. It learns the locale through the single
//    `custom-gremion` server strategy (see paraglide-options.js for why the
//    cascade cannot be split over Paraglide's built-in strategies).
// 3. transformPageChunk fills app.html's `%paraglide.lang%`, so the raw server
//    response already carries `<html lang="en">` before any script runs. That
//    tag is the language the PAGE is written in (content-locale.ts); the
//    strings render in the person's locale (step 2), which the tag carries
//    aside as data-ui-locale where the two differ. The
//    same mechanism tenantBrandStyleHandle uses; sequence() merges both.
//
// Person-preference and customer-default lookups are best-effort. The customer
// default is read for every request with a customer (anonymous too). An
// unconfigured LocalePreferencePort (Q1: no production adapter is bound until
// TASK-080) is caught so a missing DB writer never turns an unrelated page
// load into a 500, and personIdOf() is null until the subject->person mapping
// exists (Q2), so the cookie decides meanwhile.
import type { Handle } from '@sveltejs/kit'
import { resolveLocale, type Locale, type PersonLocalePreference } from './resolve-locale'
import { personIdOf } from './person-id'
import { getLocalePreferencePort, isLocalePreferenceConfigured } from './locale-preference-port'
import { GREMION_STRATEGY, LOCALE_COOKIE } from '../locale'
import { contentLocaleFor, htmlLangAttributes } from '../content-locale'
import { paraglideMiddleware } from '../paraglide/server.js'
import { defineCustomServerStrategy } from '../paraglide/runtime.js'

export { LOCALE_COOKIE }

/** The placeholder app.html carries in `<html lang="…">`. */
export const LANG_PLACEHOLDER = '%paraglide.lang%'

type LocalsLike = { user: { id: string } | null; tenant?: { id: string } | null }
type MinimalRequestEvent = {
  url?: URL
  cookies: { get(name: string): string | undefined }
  request: { headers: { get(name: string): string | null } }
  locals: LocalsLike
}

// The locale this handle resolved, keyed by the Request it hands to
// paraglideMiddleware. A WeakMap, so nothing outlives the request.
const resolvedLocales = new WeakMap<Request, Locale>()
defineCustomServerStrategy(GREMION_STRATEGY, {
  getLocale: (request) => (request ? resolvedLocales.get(request) : undefined)
})

/**
 * Pure-ish resolution step, split out from the Handle so it is testable
 * without constructing a real SvelteKit RequestEvent.
 */
export async function resolveRequestLocale(
  event: MinimalRequestEvent,
  customerIdOf: (locals: LocalsLike) => string | null
): Promise<Locale> {
  // Optional chaining is deliberate: some synthetic RequestEvents built for
  // testing other handles in the sequence (e.g. hooks.tenant-wiring.test.ts)
  // don't implement `cookies`/`request`. A real SvelteKit RequestEvent always
  // has both — this only guards against an incomplete test double, not a
  // production code path.
  const cookie = event.cookies?.get(LOCALE_COOKIE) ?? null
  const acceptLanguage = event.request?.headers?.get('accept-language') ?? null
  const personId = personIdOf(event.locals ?? { user: null })

  const customerId = event.locals ? customerIdOf(event.locals) : null

  let personPreference: PersonLocalePreference = null
  let customerDefaultLocale: Locale | null = null

  // The customer default (cascade step 4) applies to every request with a
  // customer: anonymous visitors and unmapped subjects too, not only a mapped
  // person. While no adapter is bound (Q1) the lookup is skipped without a
  // per-request warning. A mapped person with no adapter is a misconfiguration,
  // so that case still reaches getLocalePreferencePort() and is logged below.
  if (customerId && (isLocalePreferenceConfigured() || personId)) {
    try {
      const port = getLocalePreferencePort()
      if (personId) {
        const row = await port.get(customerId, personId)
        personPreference = row?.locale ?? null
      }
      customerDefaultLocale = await port.getCustomerDefault(customerId)
    } catch (err) {
      // Read side of Q1: resolve without the stored preference rather than
      // fail the page. Logged so a broken adapter is visible, not silent.
      console.warn('[i18n] locale preference read failed; falling back to cookie/header', {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  return resolveLocale({ personPreference, cookie, acceptLanguage, customerDefaultLocale })
}

/**
 * @param customerIdOf reads the tenant/customer id off locals without this
 * module importing `$lib/server/tenant/**` itself (brief §3 do-not-touch);
 * the caller (hooks.server.ts, which already reads `locals.tenant`) supplies it.
 */
export function createI18nHandle(customerIdOf: (locals: LocalsLike) => string | null): Handle {
  const handle: Handle = async ({ event, resolve }) => {
    const locale = await resolveRequestLocale(event as unknown as MinimalRequestEvent, customerIdOf)
    ;(event.locals as App.Locals & { locale?: Locale }).locale = locale

    // Two decisions, kept apart (WCAG 3.1.1 vs. the person's choice):
    //  - the DECLARED language (`<html lang>`) is the language the page is
    //    written in. SvelteKit has matched the route before handle runs; a route
    //    whose page is not proven translated (content-locale.ts, fail-safe
    //    German) is declared German for everyone, and app.html carries the
    //    person's locale aside in data-ui-locale for the client.
    //  - the RENDERED catalogue strings (the shell navigation, every `$t`/message
    //    call on the page) are in the person's locale. A string that has an
    //    English message renders in English on every route, a page that is still
    //    partly hard-coded German included. Before, Paraglide ran in the
    //    declared language, so an English person who had switched the language
    //    kept reading German chrome on every route but the login page.
    // `locals.locale` stays the person's locale (the settings switch reads it).
    const routeId = (event as { route?: { id: string | null } }).route?.id ?? null
    const contentLocale = contentLocaleFor(routeId, locale)

    // A body-less stand-in: Paraglide clones the Request it is given, and
    // cloning an upload would tee (and buffer) its body. The stand-in carries
    // only the URL, which is all a non-URL strategy needs.
    const probe = new Request(event.url)
    resolvedLocales.set(probe, locale)

    return paraglideMiddleware(probe, () =>
      resolve(event, {
        transformPageChunk: ({ html }) => html.replace(`lang="${LANG_PLACEHOLDER}"`, htmlLangAttributes(contentLocale, locale))
      })
    )
  }
  return handle
}
