import { describe, test, expect, beforeEach, vi } from 'vitest'
import { get } from 'svelte/store'

// gremion#22: the `gremion.lang` preference key (B8 / design-review 2026-07
// T5, same treatment as the theme stores in $lib/stores/theme.ts and covered
// there by theme.storage-keys.test.ts) has a one-time `stura-lang` legacy
// fallback in getInitialLang() but shipped with no direct unit coverage —
// this file closes that gap for $lib/i18n/index.ts.
//
// The store gates every localStorage touch on `browser`; force the browser
// path (inverse of the hooks tests' `building: true` mock).
vi.mock('$app/environment', () => ({ browser: true }))

// jsdom's localStorage is not wired in this vitest config (known quirk — see
// the notes in CommandPalette.test.ts / theme.storage-keys.test.ts): the
// global accessor yields undefined. Stub a spec-sufficient in-memory Storage;
// the store references the bare `localStorage` global, so this is what it hits.
function makeStorageStub(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(String(k), String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    }
  } as Storage
}
vi.stubGlobal('localStorage', makeStorageStub())

/** Fresh module instance so each test re-runs the import-time initial read. */
async function freshI18n() {
  vi.resetModules()
  return await import('./index')
}

beforeEach(() => {
  localStorage.clear()
})

describe('i18n lang store — namespaced gremion.lang key with one-time stura-lang fallback', () => {
  test('namespaced key read: gremion.lang is honored as the initial store value', async () => {
    localStorage.setItem('gremion.lang', 'en')
    const m = await freshI18n()
    expect(get(m.lang)).toBe('en')
  })

  test('legacy-key fallback migration: stura-lang is honored, migrated, and removed', async () => {
    localStorage.setItem('stura-lang', 'en')
    const m = await freshI18n()
    // honored as the initial value
    expect(get(m.lang)).toBe('en')
    // migrated: the namespaced key now carries it
    expect(localStorage.getItem('gremion.lang')).toBe('en')
    // and the legacy key is gone, so the fallback fires at most once
    expect(localStorage.getItem('stura-lang')).toBeNull()
  })

  test('default when neither key is present: falls back to de without creating keys', async () => {
    const m = await freshI18n()
    expect(get(m.lang)).toBe('de')
    expect(localStorage.getItem('gremion.lang')).toBeNull()
    expect(localStorage.getItem('stura-lang')).toBeNull()
  })

  test('the gremion.lang key wins over a stale legacy value', async () => {
    localStorage.setItem('gremion.lang', 'de')
    localStorage.setItem('stura-lang', 'en')
    const m = await freshI18n()
    expect(get(m.lang)).toBe('de')
    // the stale legacy key is left untouched — it was never consulted.
    expect(localStorage.getItem('stura-lang')).toBe('en')
  })

  test('lang.set() writes ONLY gremion.lang — never stura-lang (acceptance)', async () => {
    localStorage.setItem('stura-lang', 'en')
    const m = await freshI18n()
    const spy = vi.spyOn(localStorage, 'setItem')
    m.lang.set('en')
    const keys = spy.mock.calls.map(([k]) => k)
    spy.mockRestore()
    expect(keys).toContain('gremion.lang')
    expect(keys.filter((k) => k.startsWith('stura-'))).toEqual([])
    expect(localStorage.getItem('gremion.lang')).toBe('en')
  })
})
