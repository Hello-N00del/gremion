/**
 * locale-en unit, client half: in a real browser the shell reads the person's
 * locale from the document (`data-ui-locale` on a page declared German, else
 * `<html lang>`) and renders the navigation and the top bar in it. The server
 * half is appshell-nav-locale.ssr.test.ts; this file proves the two agree, so
 * hydration does not flip English chrome back to German.
 */
import '../../../app.css'
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/svelte'
import { page as vpage } from 'vitest/browser'
import ShellFixture from './fixtures/ShellFixture.svelte'
import { FIXTURE_NAV } from './fixtures/shell-harness'

const pageState = vi.hoisted(() => ({ url: new URL('http://localhost/members'), data: {} as Record<string, unknown> }))
vi.mock('$app/state', () => ({ page: pageState }))

const html = document.documentElement

beforeEach(() => {
  try {
    localStorage.clear()
  } catch {
    /* private mode */
  }
  html.lang = 'de'
  html.removeAttribute('data-ui-locale')
})
afterEach(() => {
  cleanup()
  html.lang = 'de'
  html.removeAttribute('data-ui-locale')
})

async function mount() {
  await vpage.viewport(1280, 800)
  render(ShellFixture, { props: { nav: FIXTURE_NAV, activeHref: '/members' } })
  await new Promise((r) => requestAnimationFrame(() => r(null)))
}

const railLabels = () => [...document.querySelectorAll('.sb-nav .sb-label')].map((e) => e.textContent?.trim())
const sectionNames = () => [...document.querySelectorAll('.sb-nav .sb-section')].map((e) => e.textContent?.trim())

describe('the shell follows the document locale in a real browser', () => {
  test('English person on a German-declared page (html lang=de, data-ui-locale=en): English navigation and top bar', async () => {
    html.lang = 'de'
    html.setAttribute('data-ui-locale', 'en')
    await mount()
    expect(sectionNames()).toEqual(['Workspace', 'Committees', 'Administration'])
    expect(railLabels()).toContain('Settings')
    expect(railLabels()).toContain('Members')
    expect(railLabels()).not.toContain('Einstellungen')
    expect(document.querySelector('button.search')?.getAttribute('aria-label')).toBe('Open command palette (Ctrl + K)')
    expect(document.querySelector('form.logout button')?.getAttribute('aria-label')).toBe('Log out')
  })

  test('English page (html lang=en): the same English chrome', async () => {
    html.lang = 'en'
    await mount()
    expect(sectionNames()).toEqual(['Workspace', 'Committees', 'Administration'])
  })

  test('German person: the German originals', async () => {
    html.lang = 'de'
    await mount()
    expect(sectionNames()).toEqual(['Arbeitsbereich', 'Gremien', 'Verwaltung'])
    expect(railLabels()).toContain('Einstellungen')
    expect(document.querySelector('button.search')?.getAttribute('aria-label')).toBe('Befehlspalette öffnen (Strg + K)')
  })
})
