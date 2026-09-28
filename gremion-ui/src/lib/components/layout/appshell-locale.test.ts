// R26-TRAIN4-FIX r4 (WCAG 3.1.1): the shell chrome speaks the page's language.
// On a German-only page (src/lib/i18n/content-locale.ts) the root layout hands
// AppShell locale="de" while the person's locale is English; the chrome's
// catalogue strings must then be German, or a page declared lang="de" carries
// English chrome. The shell stays mounted across client-side navigation, so
// the language comes in as a reactive prop, not from a one-shot store read.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'
import AppShell from './AppShell.svelte'

// $lib/stores/theme (imported by TopBar) reads localStorage at import time,
// which this jsdom does not provide: an in-memory stand-in, before any import.
vi.hoisted(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    }
  })
})

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  invalidate: vi.fn(),
  invalidateAll: vi.fn(),
  beforeNavigate: vi.fn(),
  onNavigate: vi.fn(),
  afterNavigate: vi.fn()
}))
vi.mock('$app/state', () => ({
  page: { url: new URL('http://pilot.test/beschluesse'), data: {}, route: { id: '/beschluesse' }, params: {} }
}))

const children = createRawSnippet(() => ({ render: () => '<p>Beschlüsse</p>' }))
const baseProps = { roles: [], userName: 'X', children }

const navLabel = (c: HTMLElement) => c.querySelector('nav.sb-nav')?.getAttribute('aria-label')
const menuLabel = (c: HTMLElement) => c.querySelector('.nav-hamburger')?.getAttribute('aria-label')

beforeEach(() => {
  // The person's locale as the browser sees it: <html lang="en"> (a translated page).
  document.documentElement.lang = 'en'
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  })) as unknown as typeof window.matchMedia
})

afterEach(() => {
  cleanup()
  document.documentElement.lang = ''
})

describe('AppShell renders its chrome in the locale it is given', () => {
  test('no locale prop: the current locale, as before', () => {
    const { container } = render(AppShell, { props: baseProps })
    expect(navLabel(container)).toBe('Main navigation')
    expect(menuLabel(container)).toBe('Menu')
  })

  test('locale="de" for an English person: German chrome', () => {
    const { container } = render(AppShell, { props: { ...baseProps, locale: 'de' } })
    expect(navLabel(container)).toBe('Hauptnavigation')
    expect(menuLabel(container)).toBe('Menü')
  })

  test('a client-side navigation to a German page switches the mounted chrome, and back', async () => {
    const { container, rerender } = render(AppShell, { props: { ...baseProps, locale: 'en' } })
    expect(navLabel(container)).toBe('Main navigation')
    await rerender({ ...baseProps, locale: 'de' })
    expect(navLabel(container)).toBe('Hauptnavigation')
    expect(menuLabel(container)).toBe('Menü')
    await rerender({ ...baseProps, locale: 'en' })
    expect(navLabel(container)).toBe('Main navigation')
  })
})
