// TASK-062 TDD 6 (browser half): the legacy $t / $lang shim reads the locale
// the server rendered into <html lang> (custom-gremion client strategy), never
// localStorage, so the browser cannot disagree with the SSR output.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { get } from 'svelte/store'

vi.mock('$app/environment', () => ({ browser: true }))

async function freshI18n() {
  vi.resetModules()
  return await import('./index')
}

afterEach(() => {
  document.documentElement.lang = ''
  vi.unstubAllGlobals()
})

describe('legacy $t shim in the browser (TASK-062 item 6)', () => {
  test('follows the server-rendered <html lang="en">', async () => {
    document.documentElement.lang = 'en'
    const { t, lang } = await freshI18n()
    expect(get(lang)).toBe('en')
    expect(get(t)('nav.files')).toBe('Files')
  })

  test('follows the server-rendered <html lang="de">', async () => {
    document.documentElement.lang = 'de'
    const { t, lang } = await freshI18n()
    expect(get(lang)).toBe('de')
    expect(get(t)('nav.files')).toBe('Dateien')
  })

  // The retired gremion.lang / stura-lang keys are pinned in index.storage-keys.test.ts.

  test('an unknown key falls back to the key itself (legacy contract)', async () => {
    document.documentElement.lang = 'en'
    const { t } = await freshI18n()
    expect(get(t)('no.such.key')).toBe('no.such.key')
  })

  test('an invalid <html lang> falls back to the base locale de', async () => {
    document.documentElement.lang = 'fr'
    const { lang } = await freshI18n()
    expect(get(lang)).toBe('de')
  })
})
