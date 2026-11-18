import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import { catalogueText, fragmentsOf, unchangedUnderLang, unmarkedCatalogueText } from '$lib/i18n/lang-marks.testkit'
import NewPostDialog from './NewPostDialog.svelte'
import RichTextComposer from './RichTextComposer.svelte'

// locale-en unit, WCAG 3.1.2: the news pages are declared German but render the dialog and the composer's
// controls from the catalogue in the person's language. What the author types is their own text: the
// editing surface is not called English while it has content (that would also switch the spell checker).
function dialog(locale: 'de' | 'en'): string {
  document.documentElement.lang = locale
  const { container } = render(NewPostDialog, { props: { open: true, onClose: vi.fn(), onSubmit: vi.fn() } })
  const out = container.innerHTML
  cleanup()
  return out
}

function composer(locale: 'de' | 'en', value: string, ariaLabel?: string): string {
  document.documentElement.lang = locale
  const { container } = render(RichTextComposer, { props: { value, ariaLabel } })
  const out = container.innerHTML
  cleanup()
  return out
}

afterEach(() => {
  document.documentElement.lang = ''
})

describe('NewPostDialog language marks', () => {
  it('en: every catalogue fragment sits under lang="en"', () => {
    const de = dialog('de')
    const en = dialog('en')
    expect(catalogueText(de, en).length, 'the guard sees catalogue text').toBeGreaterThanOrEqual(4)
    expect(unmarkedCatalogueText(de, en, 'en').map((f) => `${f.where} ${JSON.stringify(f.text)}`)).toEqual([])
  })

  it('en: nothing under lang="en" is a German literal', () => {
    expect(unchangedUnderLang(dialog('de'), dialog('en'), 'en').filter((f) => /\p{L}{2,}/u.test(f.text))).toEqual([])
  })
})

describe('RichTextComposer language marks', () => {
  it.each([
    ['empty', ''],
    ['with text', '<p>Hallo Welt</p>']
  ])('en, %s: every catalogue fragment is marked English, or reaches the surface through a marked label', (_name, value) => {
    const de = composer('de', value)
    const en = composer('en', value)
    expect(catalogueText(de, en).length, 'the guard sees catalogue text').toBeGreaterThanOrEqual(8)
    expect(unmarkedCatalogueText(de, en, 'en').map((f) => `${f.where} ${JSON.stringify(f.text)}`)).toEqual([])
  })

  it('en: the surface is named by a marked label, and marked itself only while blank', () => {
    for (const [value, marked] of [['', true], ['<p>Hallo Welt</p>', false]] as const) {
      const container = document.createElement('div')
      container.innerHTML = composer('en', value)
      const surface = container.querySelector('[role="textbox"]')!
      expect(surface.getAttribute('lang') === 'en', `blank=${marked}`).toBe(marked)
      const label = container.querySelector(`[id="${surface.getAttribute('aria-labelledby')}"]`)
      expect(label?.getAttribute('lang')).toBe('en')
    }
  })

  it('a caller-supplied label is the caller\'s text and language, not marked English', () => {
    const container = document.createElement('div')
    container.innerHTML = composer('en', '', 'Inhalt bearbeiten')
    const label = [...container.querySelectorAll('.sr-only')].find((e) => e.textContent === 'Inhalt bearbeiten')
    expect(label, 'the caller label is rendered').toBeDefined()
    expect(label!.hasAttribute('lang')).toBe(false)
    expect(fragmentsOf(container.innerHTML).find((f) => f.text === 'Inhalt bearbeiten')?.lang).toBe('de')
  })
})
