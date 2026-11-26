// @vitest-environment node
//
// locale-en unit: the command palette is part of the shell chrome and follows
// the interface language. Its dialog name, search field, section headings,
// quick action and key hints were hard-coded German, so an English person who
// opened it read the page names from the (now English) navigation next to a
// German "Seiten / Aktionen / Theme wechseln".
import { describe, expect, test, vi } from 'vitest'
import { render } from 'svelte/server'
import CommandPalette from './CommandPalette.svelte'
import { paraglideMiddleware } from '../i18n/paraglide/server.js'
import { defineCustomServerStrategy } from '../i18n/paraglide/runtime.js'
import { GREMION_STRATEGY, type Locale } from '../i18n/locale'

vi.mock('$app/environment', () => ({ browser: false, building: false, dev: true, version: 'test' }))
vi.mock('$app/navigation', () => ({ goto: vi.fn() }))
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

const localeOf = new WeakMap<Request, Locale>()
defineCustomServerStrategy(GREMION_STRATEGY, { getLocale: (request) => (request ? localeOf.get(request) : undefined) })

const nav = [{ kind: 'item' as const, href: '/calendar', label: 'Calendar', icon: 'calendar' }]

async function palette(locale: Locale): Promise<string> {
  const request = new Request('https://pilot.test/')
  localeOf.set(request, locale)
  const response = await paraglideMiddleware(
    request,
    () => new Response(render(CommandPalette, { props: { open: true, nav } }).body)
  )
  return await response.text()
}

describe('command palette follows the interface locale', () => {
  test('en: dialog name, search field, headings, action and key hints are English', async () => {
    const html = await palette('en')
    for (const text of ['aria-label="Command palette"', 'placeholder="Search … minutes, event, person"', 'aria-label="Results"', '>Pages<', '>Actions<', 'Switch theme', 'Toggle light / dark', 'Navigate', 'Open', 'Close']) {
      expect(html, text).toContain(text)
    }
    for (const german of ['Befehlspalette', 'Suche …', 'Ergebnisse', '>Seiten<', '>Aktionen<', 'Theme wechseln', 'umschalten', 'Personen', 'folgt', 'Navigieren', 'Öffnen', 'Schließen']) {
      expect(html, german).not.toContain(german)
    }
  })

  test('de: the German originals', async () => {
    const html = await palette('de')
    for (const text of ['aria-label="Befehlspalette"', 'placeholder="Suche … Protokoll, Termin, Person"', 'aria-label="Ergebnisse"', '>Seiten<', '>Aktionen<', 'Theme wechseln', 'Hell / Dunkel umschalten', 'Navigieren', 'Öffnen', 'Schließen']) {
      expect(html, text).toContain(text)
    }
    expect(html).not.toContain('Command palette')
    expect(html).not.toContain('folgt')
  })

  // WCAG 3.1.2: a rail label the translation does not reach stays German (localizeNav marks it lang 'de');
  // the palette lists it inside its English dialog, so it keeps that mark.
  test('en: a page label the translation did not reach is marked German inside the English dialog', async () => {
    const request = new Request('https://pilot.test/')
    localeOf.set(request, 'en')
    const reached = { kind: 'item' as const, href: '/calendar', label: 'Calendar', icon: 'calendar' }
    const kept = { kind: 'item' as const, href: '/ausschuesse', label: 'Ausschüsse', icon: 'users', lang: 'de' }
    const response = await paraglideMiddleware(
      request,
      () => new Response(render(CommandPalette, { props: { open: true, nav: [reached, kept], lang: 'en' } }).body)
    )
    const html = await response.text()
    expect(html).toMatch(/role="dialog"[^>]* lang="en"/)
    expect(html).toMatch(/<span class="cp-label[^"]*" lang="de">Ausschüsse<\/span>/)
    expect(html).toMatch(/<span class="cp-label[^"]*">Calendar<\/span>/)
  })
})
