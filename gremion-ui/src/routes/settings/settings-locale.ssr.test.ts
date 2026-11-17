// @vitest-environment node
//
// locale-en unit: the settings page follows the interface language. The
// section navigation, its group names, the section heading and its subtitle
// were hard-coded German, so an English person who had just switched the
// language on this very page still read German around the switch.
//
// Rendered in Paraglide's request scope, as the i18n handle does. The tab bodies
// themselves (organisation, services, email, ...) are not part of this unit.
import { describe, expect, test, vi } from 'vitest'
import { render } from 'svelte/server'
import SettingsBody from './SettingsBody.svelte'
import { paraglideMiddleware } from '../../lib/i18n/paraglide/server.js'
import { defineCustomServerStrategy } from '../../lib/i18n/paraglide/runtime.js'
import { GREMION_STRATEGY, type Locale } from '../../lib/i18n/locale'

vi.mock('$app/environment', () => ({ browser: false, building: false, dev: true, version: 'test' }))
vi.mock('$app/navigation', () => ({ goto: vi.fn() }))
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return { page: readable({ url: new URL('https://pilot.test/settings/darstellung'), form: null, data: {} }) }
})
vi.mock('$app/state', () => ({ page: { url: new URL('https://pilot.test/settings/darstellung'), form: null } }))

const localeOf = new WeakMap<Request, Locale>()
defineCustomServerStrategy(GREMION_STRATEGY, { getLocale: (request) => (request ? localeOf.get(request) : undefined) })

const data = {
  config: null,
  isAdmin: true,
  isITAdmin: true,
  loeschkonzept: null,
  user: { name: 'E2E Admin', email: 'admin@example.test', groups: [] },
  accountUrl: null,
  mfaEnrolled: null,
  stepUpEnforced: false
}

async function settings(locale: Locale, activeSection?: string): Promise<string> {
  const request = new Request('https://pilot.test/settings')
  localeOf.set(request, locale)
  const response = await paraglideMiddleware(
    request,
    () => new Response(render(SettingsBody, { props: { data: data as never, activeSection } }).body)
  )
  return await response.text()
}

const nav = (html: string) => /<nav class="set-nav"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? ''

describe('settings chrome follows the interface locale', () => {
  test('en: group names, section names, section heading and subtitle are English', async () => {
    const html = await settings('en', 'darstellung')
    const n = nav(html)
    expect(n).toContain('aria-label="Settings sections"')
    for (const word of ['Account', 'Administration', 'Appearance &amp; accessibility', 'Profile', 'Organisation', 'Modules', 'Services &amp; portal', 'Retention periods', 'Danger zone']) {
      expect(n, word).toContain(word)
    }
    for (const german of ['Konto', 'Verwaltung', 'Darstellung', 'Löschfristen', 'Gefahrenzone', 'Einstellungsbereiche']) {
      expect(n, german).not.toContain(german)
    }
    expect(html).toContain('Language, font size, colour vision and motion.')
    expect(html).toContain('Manage your account, organisation and system.')
  })

  test('de: the German originals, unchanged', async () => {
    const html = await settings('de', 'darstellung')
    const n = nav(html)
    expect(n).toContain('aria-label="Einstellungsbereiche"')
    for (const word of ['Konto', 'Verwaltung', 'Darstellung &amp; Barrierefreiheit', 'Profil', 'Dienste &amp; Portal', 'Löschfristen', 'Gefahrenzone']) {
      expect(n, word).toContain(word)
    }
    expect(html).toContain('Sprache, Schriftgröße, Farbsehen und Bewegung.')
    expect(html).toContain('Konto, Organisation und System verwalten.')
    expect(html).not.toContain('Danger zone')
  })

  test('en: the sidebar note and the profile note are English', async () => {
    const html = await settings('en')
    expect(html).toContain('<b>Members</b>')
    expect(html).toContain('are managed directly through the navigation')
    expect(html).toContain('You find the interface language under')
    expect(html).not.toContain('Sprache der Oberfläche')
  })

  test('de: the sidebar note keeps its German wording and bold words', async () => {
    const html = await settings('de')
    expect(html).toMatch(/<b>Mitglieder<\/b>, <b>Gremien<\/b>\s+und <b>Abstimmungen<\/b>\s+verwalten Sie direkt über die Navigation/)
    expect(html).toMatch(/Sprache der Oberfläche finden Sie unter\s*<b[^>]*>Darstellung &amp; Barrierefreiheit<\/b>/)
  })
})
