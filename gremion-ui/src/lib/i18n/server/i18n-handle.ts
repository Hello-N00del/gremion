// TASK-062 TDD 2/7 — i18nHandle (brief §6.2/6.7, TRD-412/TRD-324).
//
// Resolves the request's locale (resolveLocale's cascade) and rewrites the
// static app.html's `lang="de"` to the resolved value via transformPageChunk
// — the same mechanism tenantBrandStyleHandle already uses for the per-tenant
// accent <style> tag, so both survive sequence() (brief §4). This is what
// makes a no-cookie `Accept-Language: en-US` request come back with
// `<html lang="en"` in the raw server response, before any client script runs
// (item 2's acceptance).
//
// Person-preference and customer-default lookups are best-effort:
//   - LocalePreferencePort has no production adapter yet (Q1 residual) — an
//     unconfigured port throws on getLocalePreferencePort(), which is caught
//     here so a missing DB writer never turns into a 500 for an unrelated
//     page load.
//   - personIdOf() returns null until the subject->person mapping exists (Q2
//     residual), so the person-preference branch is inert until TASK-031/080
//     land it; the cookie step covers the gap meanwhile.
import type { Handle } from '@sveltejs/kit'
import { resolveLocale, type Locale, type PersonLocalePreference } from './resolve-locale'
import { personIdOf } from './person-id'
import { getLocalePreferencePort } from './locale-preference-port'

/** Per-device mirror of the signed-in person's choice (brief §5 Q4); Path=/ so
 * it applies to the whole app, SameSite=Lax (same posture as the session
 * cookie), Secure is added by the switch action itself once TLS is confirmed
 * at the call site (brief §7 review watch-item). */
export const LOCALE_COOKIE = 'gremion.locale'

type LocalsLike = { user: { id: string } | null; tenant?: { id: string } | null }
type MinimalRequestEvent = {
  cookies: { get(name: string): string | undefined }
  request: { headers: { get(name: string): string | null } }
  locals: LocalsLike
}

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

  let personPreference: PersonLocalePreference = null
  let customerDefaultLocale: Locale | null = null

  if (personId) {
    try {
      const port = getLocalePreferencePort()
      const customerId = customerIdOf(event.locals)
      if (customerId) {
        const row = await port.get(customerId, personId)
        personPreference = row?.locale ?? null
        customerDefaultLocale = await port.getCustomerDefault(customerId)
      }
    } catch {
      // LocalePreferencePort not configured in this environment yet (Q1
      // residual) — resolve without a person-level preference rather than
      // fail the request.
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

    return resolve(event, {
      transformPageChunk: ({ html }) => html.replace(/lang="de"/, `lang="${locale}"`)
    })
  }
  return handle
}
