import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import type { ModuleDeletionPreview } from '$lib/modules/switch-preview'
import { catalogueText, fragmentsOf, unchangedUnderLang, unmarkedCatalogueText } from '$lib/i18n/lang-marks.testkit'
import ModuleOffWarning from './ModuleOffWarning.svelte'

// locale-en unit, WCAG 3.1.2: the module warning is catalogue text on pages declared German. In the person's
// language it carries lang; the item names and units the server sends are German and must not be marked English.
const preview: ModuleDeletionPreview = {
  moduleId: 'votes',
  moduleLabel: 'Abstimmungen',
  confirmPhrase: 'Abstimmungen',
  deletes: [
    { key: 'open', label: 'Offene Abstimmungen', count: 3, unit: 'Abstimmungen' },
    { key: 'archive', label: 'Archiv', count: null, unit: '' }
  ],
  retained: [{ key: 'seal', label: 'Versiegelte Kopie', basis: 'Aufbewahrungspflicht' }],
  graceDays: 30,
  finalDeletionAt: '2026-12-01',
  recoverable: true
}

function html(locale: 'de' | 'en'): string {
  document.documentElement.lang = locale
  const { container } = render(ModuleOffWarning, { props: { preview, busy: false, error: null, onconfirm: vi.fn(), oncancel: vi.fn() } })
  const out = container.innerHTML
  cleanup()
  return out
}

afterEach(() => {
  document.documentElement.lang = ''
})

describe('ModuleOffWarning language marks', () => {
  it('en: every catalogue fragment sits under lang="en"', () => {
    const de = html('de')
    const en = html('en')
    expect(catalogueText(de, en).length, 'the guard sees catalogue text').toBeGreaterThan(5)
    expect(unmarkedCatalogueText(de, en, 'en').map((f) => `${f.where} ${JSON.stringify(f.text)}`)).toEqual([])
  })

  it('en: the server-sent item names are marked German, not English', () => {
    const en = html('en')
    const byText = new Map(fragmentsOf(en).map((f) => [f.text, f.lang]))
    expect(byText.get('Offene Abstimmungen')).toBe('de')
    expect(byText.get('3 Abstimmungen')).toBe('de')
    expect(byText.get('Versiegelte Kopie (Aufbewahrungspflicht)')).toBe('de')
  })

  it('en: nothing else under lang="en" is a German literal', () => {
    const suspects = unchangedUnderLang(html('de'), html('en'), 'en').filter((f) => /\p{L}{2,}/u.test(f.text))
    expect(suspects.map((f) => f.text)).toEqual([])
  })
})
