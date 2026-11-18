import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import { catalogueText, unchangedUnderLang, unmarkedCatalogueText } from '$lib/i18n/lang-marks.testkit'
import ElectionsNotice from './ElectionsNotice.svelte'

// locale-en unit, WCAG 3.1.2: the elections notice sits in the elections layout, whose pages are declared
// German. Its text is catalogue text in the person's language, so it carries that language.
function html(locale: 'de' | 'en', address: 'du' | 'sie' = 'du'): string {
  document.documentElement.lang = locale
  const { container } = render(ElectionsNotice, { props: { address } })
  const out = container.innerHTML
  cleanup()
  return out
}

afterEach(() => {
  document.documentElement.lang = ''
})

describe('ElectionsNotice language marks', () => {
  it('en: every catalogue fragment sits under lang="en", for both forms of address', () => {
    for (const address of ['du', 'sie'] as const) {
      const de = html('de', address)
      const en = html('en', address)
      expect(catalogueText(de, en).length, 'the guard sees catalogue text').toBeGreaterThanOrEqual(3)
      expect(unmarkedCatalogueText(de, en, 'en').map((f) => `${f.where} ${JSON.stringify(f.text)}`)).toEqual([])
    }
  })

  it('en: nothing under lang="en" is a German literal', () => {
    expect(unchangedUnderLang(html('de'), html('en'), 'en').filter((f) => /\p{L}{2,}/u.test(f.text))).toEqual([])
  })
})
