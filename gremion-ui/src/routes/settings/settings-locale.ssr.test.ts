// @vitest-environment node
//
// locale-en unit: the settings page follows the interface language. The
// section navigation, its group names, the section heading and its subtitle
// were hard-coded German, so an English person who had just switched the
// language on this very page still read German around the switch.
//
// Rendered in Paraglide's request scope, as the i18n handle does. The Profil tab (the landing tab of every
// person) and the Darstellung tab (where the language is switched) follow it; the administrator-only tab bodies
// (organisation, services, email,
// legal, data protection, backups, retention, danger zone) are still German and are not part of this unit.
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

  test('en: the appearance tab (where the language is switched) is English throughout', async () => {
    const html = (await settings('en', 'darstellung')).replace(/\s+/g, ' ')
    for (const text of ['Colour vision correction', 'No correction', 'Red-green deficiency', 'Blue-yellow deficiency', 'Preview', 'Accent', 'Amber', '>Appearance<', 'Choose between light and dark mode.', ' Light<', 'Font size', 'Extra large', '>Animations<', 'Reduce animations', 'aria-label="Reduce animations"']) {
      expect(html, text).toContain(text)
    }
    for (const german of ['Farbsehkorrektur', 'Keine Korrektur', 'Rot-Grün', 'Vorschau', 'Bernstein', 'Erscheinungsbild', 'Schriftgröße', 'Sehr groß', 'Animationen', 'Bewegungseffekte']) {
      expect(html, german).not.toContain(german)
    }
  })

  test('de: the appearance tab keeps its German wording', async () => {
    const html = (await settings('de', 'darstellung')).replace(/\s+/g, ' ')
    for (const text of ['>Farbsehkorrektur<', 'Keine Korrektur', 'Deuteranopie / Protanopie — betrifft ca. 8 % der Männer', '>Vorschau<', '>Bernstein<', '>Erscheinungsbild<', 'Wählen Sie zwischen hellem und dunklem Modus.', ' Hell<', '>Schriftgröße<', 'Sehr groß', 'aria-label="Animationen reduzieren"', 'Deaktiviert Übergänge und Bewegungseffekte in der Oberfläche']) {
      expect(html, text).toContain(text)
    }
    expect(html).not.toContain('Colour vision')
  })

  test('en: the profile tab (the page every person lands on) is English', async () => {
    const withProfile = { ...data, profile: { firstName: 'A', lastName: 'B', email: 'a@example.test' }, emailActionAvailable: true }
    const request = new Request('https://pilot.test/settings')
    localeOf.set(request, 'en')
    const response = await paraglideMiddleware(
      request,
      () => new Response(render(SettingsBody, { props: { data: withProfile as never, activeSection: 'profil' } }).body)
    )
    const html = (await response.text()).replace(/\s+/g, ' ')
    for (const text of ['>First name<', '>Last name<', 'Save name', 'Sign-in', 'Change password', 'Set up two-factor code again', 'Change email address', 'This is how you appear in committees, messages and files.']) {
      expect(html, text).toContain(text)
    }
    for (const german of ['Vorname', 'Nachname', 'Namen speichern', 'Anmeldung', 'Passwort ändern', 'neu einrichten', 'E-Mail-Adresse ändern', 'So erscheinen Sie']) {
      expect(html, german).not.toContain(german)
    }
  })

  test('de: the profile tab keeps its German wording', async () => {
    const withProfile = { ...data, profile: { firstName: 'A', lastName: 'B', email: 'a@example.test' }, emailActionAvailable: true }
    const request = new Request('https://pilot.test/settings')
    localeOf.set(request, 'de')
    const response = await paraglideMiddleware(
      request,
      () => new Response(render(SettingsBody, { props: { data: withProfile as never, activeSection: 'profil' } }).body)
    )
    const html = (await response.text()).replace(/\s+/g, ' ')
    for (const text of ['>Vorname<', '>Nachname<', 'Namen speichern', '>Anmeldung<', 'Passwort ändern', 'Zwei-Faktor-Code neu einrichten', 'E-Mail-Adresse ändern', 'So erscheinen Sie in Gremium, Nachrichten und Dateien.']) {
      expect(html, text).toContain(text)
    }
    expect(html).not.toContain('Save name')
  })

  // Source line breaks inside a sentence render as one space; compare the rendered text, not the markup.
  const flat = (html: string) => html.replace(/\s+/g, ' ')

  test('en: the sidebar note and the profile note are English', async () => {
    const html = flat(await settings('en'))
    expect(html).toContain('<b>Members</b>, <b>Committees</b> and <b>Votes</b> are managed directly through the navigation')
    expect(html).toMatch(/You find the interface language under <b[^>]*>Appearance &amp; accessibility<\/b>/)
    expect(html).not.toContain('Sprache der Oberfläche')
    expect(html).not.toContain('verwalten Sie direkt')
  })

  test('de: the sidebar note keeps its German wording and bold words', async () => {
    const html = flat(await settings('de'))
    expect(html).toContain('<b>Mitglieder</b>, <b>Gremien</b> und <b>Abstimmungen</b> verwalten Sie direkt über die Navigation')
    expect(html).toMatch(/Sprache der Oberfläche finden Sie unter <b[^>]*>Darstellung &amp; Barrierefreiheit<\/b>/)
    expect(html).not.toContain('managed directly')
  })
})
