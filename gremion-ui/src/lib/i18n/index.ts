import { browser } from '$app/environment'
import { writable, derived } from 'svelte/store'
import de from './de'
import en from './en'

export type Language = 'de' | 'en'

// B8 (design-review 2026-07 T5): namespaced key with a one-time legacy
// fallback (old key honored + migrated, never written again) — same treatment
// as the theme stores in $lib/stores/theme.ts.
const LANG_KEY = 'gremion.lang'
const LEGACY_LANG_KEY = 'stura-lang'

const translations: Record<Language, Record<string, string>> = { de, en }

function getInitialLang(): Language {
  if (!browser) return 'de'
  // TASK-062 item 6: i18nHandle (hooks.server.ts) already set the correct
  // <html lang> server-side from resolveLocale's cascade, before this script
  // runs — honor it over localStorage so the reactive $t store agrees with
  // what the server just rendered instead of a stale/foreign per-device
  // value flashing over it. An empty/invalid attribute (not yet wired, or a
  // test harness) falls through to the pre-existing logic unchanged.
  const ssrLang = document.documentElement.lang
  if (ssrLang === 'en' || ssrLang === 'de') return ssrLang
  let raw = localStorage.getItem(LANG_KEY)
  if (raw === null) {
    raw = localStorage.getItem(LEGACY_LANG_KEY)
    if (raw !== null) {
      localStorage.setItem(LANG_KEY, raw)
      localStorage.removeItem(LEGACY_LANG_KEY)
    }
  }
  return raw === 'en' ? 'en' : 'de'
}

const langStore = writable<Language>(getInitialLang())

export const lang = {
  subscribe: langStore.subscribe,
  set(l: Language) {
    langStore.set(l)
    if (browser) {
      localStorage.setItem(LANG_KEY, l)
      document.documentElement.lang = l
    }
  }
}

/**
 * Reactive translation function.
 * Usage in components: `$t('nav.files')`
 * Falls back to the key itself if no translation is found.
 */
export const t = derived(langStore, ($lang) => {
  const dict = translations[$lang]
  return (key: string): string => dict[key] ?? key
})
