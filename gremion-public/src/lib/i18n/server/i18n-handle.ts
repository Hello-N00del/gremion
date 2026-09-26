// TASK-062 TDD 2 (gremion-public, brief §6.2/TRD-412/TRD-324).
//
// gremion-public has no session (app.d.ts), so this is the cookie/
// Accept-Language tail of the cascade only — no person preference, no
// customer default. Rewrites app.html's `lang="de"` to the resolved value
// via transformPageChunk so the raw server response carries the right
// `<html lang>` before any client script runs (curl-testable).
import type { Handle } from '@sveltejs/kit'
import { resolveLocale, type Locale } from './resolve-locale'

/** Per-device locale mirror; Path=/, SameSite=Lax (no signed-in person here
 * to escalate this to a DB-backed preference — see the TASK-062 report). */
export const LOCALE_COOKIE = 'gremion.locale'

type MinimalRequestEvent = {
  cookies: { get(name: string): string | undefined }
  request: { headers: { get(name: string): string | null } }
  locals: Record<string, unknown>
}

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

    return resolve(event, {
      transformPageChunk: ({ html }) => html.replace(/lang="de"/, `lang="${locale}"`)
    })
  }
  return handle
}
