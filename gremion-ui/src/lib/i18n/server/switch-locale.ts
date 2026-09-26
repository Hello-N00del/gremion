// TASK-062 TDD 5 — the language switch (brief §1 post-condition 3, FLOW-UXQ-001).
//
// A plain form POST answered by a 303, so it works with JavaScript off and the
// next document is server-rendered in the new locale: there is no client-side
// `lang` mutation to flash. Order of effects:
//   1. validate the locale (400, nothing changed, on anything but de/en);
//   2. set the per-device cookie (Q4: the person row is the source of truth,
//      the cookie its per-device mirror). It switches even if step 3 fails
//      (brief Q1 default);
//   3. write idt.preference through the LocalePreferencePort when a person id
//      exists (Q2: personIdOf() is null until the subject->person mapping lands,
//      and the cookie decides meanwhile);
//   4. 303 back to the page the form was on.
// A failed write is returned as an action failure the page shows to the
// person, and logged. It is never swallowed into a success.
import { fail, redirect } from '@sveltejs/kit'
import { LOCALE_COOKIE, asSupportedLocale } from '../locale'
import type { LocalePreferencePort } from './locale-preference-port'

/** One year. The choice is long-lived; the person row outlives it anyway. */
export const LOCALE_COOKIE_OPTIONS_MAX_AGE = 60 * 60 * 24 * 365

const DEFAULT_TARGET = '/settings/darstellung'

export interface SwitchLocaleDeps {
  personIdOf(locals: unknown): string | null
  customerIdOf(locals: unknown): string | null
  /** Resolved lazily: it throws while no adapter is configured, which only matters once a person id exists. */
  port(): LocalePreferencePort
}

export interface SwitchLocaleEvent {
  request: Request
  url: URL
  cookies: { set(name: string, value: string, opts: { path: string } & Record<string, unknown>): void }
  locals: unknown
}

/** Same-origin absolute path only: no scheme, no protocol-relative `//`, no backslash tricks. */
function safeTarget(value: FormDataEntryValue | null): string {
  if (typeof value !== 'string') return DEFAULT_TARGET
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return DEFAULT_TARGET
  return value
}

export async function switchLocale(event: SwitchLocaleEvent, deps: SwitchLocaleDeps) {
  const form = await event.request.formData()
  const locale = asSupportedLocale(form.get('locale'))
  if (!locale) return fail(400, { localeError: 'invalid' as const })

  event.cookies.set(LOCALE_COOKIE, locale, {
    path: '/',
    sameSite: 'lax',
    httpOnly: true,
    secure: event.url.protocol === 'https:',
    maxAge: LOCALE_COOKIE_OPTIONS_MAX_AGE
  })

  const personId = deps.personIdOf(event.locals)
  const customerId = deps.customerIdOf(event.locals)
  if (personId && customerId) {
    try {
      await deps.port().set(customerId, personId, locale)
    } catch (err) {
      console.error('[i18n] locale preference write failed; the cookie switched, the profile did not', {
        error: err instanceof Error ? err.message : String(err)
      })
      return fail(503, { localeError: 'not-saved' as const, locale })
    }
  }

  redirect(303, safeTarget(form.get('redirectTo')))
}
