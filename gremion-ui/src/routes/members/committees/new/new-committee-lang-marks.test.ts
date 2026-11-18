import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/svelte'
import { catalogueText, unmarkedCatalogueText } from '$lib/i18n/lang-marks.testkit'
import Page from './+page.svelte'

vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }))
vi.mock('$app/state', () => ({ page: { data: {}, url: new URL('https://pilot.test/members/committees/new') } }))

// locale-en unit, WCAG 3.1.2: the page is declared German. Its catalogue text carries the person's language;
// the fields hold what the person types (a committee name, usually German), so they are marked English only
// while they are empty and show their placeholder.
function html(locale: 'de' | 'en'): string {
  document.documentElement.lang = locale
  const { container } = render(Page, { props: { data: {} as never, form: null } })
  const out = container.innerHTML
  cleanup()
  return out
}

afterEach(() => {
  document.documentElement.lang = ''
})

describe('new committee page language marks', () => {
  it('en: every catalogue fragment, the placeholders included, sits under lang="en"', () => {
    const de = html('de')
    const en = html('en')
    expect(catalogueText(de, en).length, 'the guard sees catalogue text').toBeGreaterThanOrEqual(5)
    expect(unmarkedCatalogueText(de, en, 'en').map((f) => `${f.where} ${JSON.stringify(f.text)}`)).toEqual([])
  })

  it('en: a field is marked English while empty and loses the mark once the person has typed', async () => {
    document.documentElement.lang = 'en'
    const { container } = render(Page, { props: { data: {} as never, form: null } })
    const name = container.querySelector('#name') as HTMLInputElement
    const description = container.querySelector('#description') as HTMLTextAreaElement
    expect(name.getAttribute('lang')).toBe('en')
    expect(description.getAttribute('lang')).toBe('en')
    await fireEvent.input(name, { target: { value: 'Fachschaftsrat' } })
    expect(name.hasAttribute('lang')).toBe(false)
    expect(description.getAttribute('lang')).toBe('en')
    await fireEvent.input(name, { target: { value: '' } })
    expect(name.getAttribute('lang')).toBe('en')
    cleanup()
  })
})
