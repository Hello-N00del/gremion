import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { get } from 'svelte/store'

// gremion#22 pinned the `gremion.lang` preference key and its one-time
// `stura-lang` legacy fallback here. TASK-062 (brief §4, deletion-aware)
// retires both keys: the person's stored preference (idt.preference) and its
// per-device cookie mirror are the source of truth, and the server renders
// the locale into <html lang> before any client script runs.
//
// Deletion ledger: this file stays (it is in scripts/port-back/do-not-overwrite.json)
// and now pins the retirement itself. A stale value under either key is
// ignored, never read, never migrated and never rewritten, so no browser can
// resurrect the old per-device flash.
vi.mock('$app/environment', () => ({ browser: true }))

function makeStorageStub(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(String(k), String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    }
  } as Storage
}

let storage: Storage

async function freshI18n() {
  vi.resetModules()
  return await import('./index')
}

beforeEach(() => {
  storage = makeStorageStub()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => {
  document.documentElement.lang = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('retired gremion.lang / stura-lang keys (TASK-062 deletion ledger)', () => {
  test('a stale gremion.lang value is ignored: the server-rendered <html lang> decides', async () => {
    storage.setItem('gremion.lang', 'de')
    document.documentElement.lang = 'en'
    const { t, lang } = await freshI18n()
    expect(get(lang)).toBe('en')
    expect(get(t)('nav.files')).toBe('Files')
  })

  test('a stale stura-lang value is ignored and not migrated to gremion.lang', async () => {
    storage.setItem('stura-lang', 'en')
    document.documentElement.lang = 'de'
    const { lang } = await freshI18n()
    expect(get(lang)).toBe('de')
    expect(storage.getItem('gremion.lang')).toBeNull()
    expect(storage.getItem('stura-lang')).toBe('en')
  })

  test('neither key is read or written while the shim evaluates', async () => {
    storage.setItem('gremion.lang', 'de')
    storage.setItem('stura-lang', 'de')
    const getItem = vi.spyOn(storage, 'getItem')
    const setItem = vi.spyOn(storage, 'setItem')
    const removeItem = vi.spyOn(storage, 'removeItem')
    document.documentElement.lang = 'en'
    const { t, lang } = await freshI18n()
    get(lang)
    get(t)('nav.files')
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
  })

  test('the shim exposes no setter, so nothing can write a per-device key again', async () => {
    const { lang } = await freshI18n()
    expect('set' in lang).toBe(false)
    expect('update' in lang).toBe(false)
  })
})
