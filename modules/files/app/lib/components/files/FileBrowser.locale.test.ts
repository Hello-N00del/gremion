import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import { catalogueText, fragmentsOf, unchangedUnderLang, unmarkedCatalogueText } from '$lib/i18n/lang-marks.testkit'
import FileBrowser from './FileBrowser.svelte'

vi.mock('$app/navigation', () => ({ goto: vi.fn() }))

// locale-en unit, WCAG 3.1.2: /files is declared German, but the browser's chrome (toolbar, status lines,
// column heads, dialogs) renders from the catalogue in the person's language and must say so. File and
// folder names are the user's own text and must not be called English.
beforeEach(() => {
  // The listing never arrives: the component stays in its loading state, which is catalogue text too.
  vi.stubGlobal('fetch', () => new Promise(() => {}))
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.lang = ''
})

function html(locale: 'de' | 'en', rootPath = ''): string {
  document.documentElement.lang = locale
  const { container } = render(FileBrowser, { props: { rootPath, readonly: false } })
  const out = container.innerHTML
  cleanup()
  return out
}

describe('FileBrowser language marks', () => {
  it('en: every catalogue fragment sits under lang="en"', () => {
    const de = html('de')
    const en = html('en')
    expect(catalogueText(de, en).length, 'the guard sees catalogue text').toBeGreaterThanOrEqual(3)
    expect(unmarkedCatalogueText(de, en, 'en').map((f) => `${f.where} ${JSON.stringify(f.text)}`)).toEqual([])
  })

  it('en: nothing under lang="en" is a German literal', () => {
    expect(unchangedUnderLang(html('de'), html('en'), 'en').filter((f) => /\p{L}{2,}/u.test(f.text))).toEqual([])
  })

  it('en: the folder levels below the root are the user\'s own text, not English', () => {
    const levels = new Map(fragmentsOf(html('en', 'Protokolle/2026')).map((f) => [f.text, f.lang]))
    expect(levels.get('2026')).toBe('')
    expect(levels.get('Protokolle')).toBe('')
  })
})
