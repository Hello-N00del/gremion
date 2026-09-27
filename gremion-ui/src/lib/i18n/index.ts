// TASK-062 (TRD-412, brief §4): the legacy `$t` / `$lang` API as a thin shim
// over the Paraglide-compiled catalogue (messages/{de,en}.json). The 17
// `$lib/i18n` consumers keep working unchanged; new code imports message
// functions from './paraglide/messages.js' directly.
//
// The locale is never decided here. On the server it is the request's locale,
// held by Paraglide's AsyncLocalStorage (server/i18n-handle.ts runs
// paraglideMiddleware around resolve()). In the browser the `custom-gremion`
// strategy reads back the `<html lang>` the server rendered. Server and client
// therefore agree by construction, which removes the old flash (the store used
// to return 'de' on the server and read localStorage in the browser).
//
// Both stores are evaluated when a component subscribes, never at module load:
// a module-level value would be shared by every concurrent SSR request.
//
// Deletion ledger (brief §4): the per-device `gremion.lang` / `stura-lang`
// localStorage keys are no longer read or written. The person's stored
// preference (idt.preference) and its per-device cookie mirror replace them;
// a stale key is left untouched and ignored.
import { browser } from '$app/environment'
import type { Readable } from 'svelte/store'
import * as compiled from './paraglide/messages.js'
import { defineCustomClientStrategy, getLocale } from './paraglide/runtime.js'
import { GREMION_STRATEGY, asSupportedLocale, type Locale } from './locale'

export type Language = Locale

type MessageFn = (inputs?: Record<string, never>, options?: { locale?: Language }) => string
const messages = compiled as unknown as Record<string, MessageFn | undefined>

if (browser) {
  defineCustomClientStrategy(GREMION_STRATEGY, {
    getLocale: () => asSupportedLocale(document.documentElement.lang) ?? undefined,
    // Switching is a form POST + 303 (routes/settings/+page.server.ts), so the
    // next document arrives already rendered in the new locale. Nothing to do.
    setLocale: () => {}
  })
}

function currentLocale(): Language {
  return asSupportedLocale(getLocale()) ?? 'de'
}

/** Looks a legacy dotted key up in the compiled catalogue; unknown keys fall back to the key itself. */
export function translate(locale: Language): (key: string) => string {
  return (key: string): string => {
    const fn = messages[key]
    return typeof fn === 'function' ? fn({}, { locale }) : key
  }
}

function evaluatedOnSubscribe<T>(value: () => T): Readable<T> {
  return {
    subscribe(run) {
      run(value())
      return () => {}
    }
  }
}

/** The current locale ('de' | 'en'). Read-only: change it through the settings switch. */
export const lang: Readable<Language> = evaluatedOnSubscribe(currentLocale)

/**
 * Reactive translation function.
 * Usage in components: `$t('nav.files')`
 * Falls back to the key itself if no translation is found.
 */
export const t: Readable<(key: string) => string> = evaluatedOnSubscribe(() => translate(currentLocale()))
