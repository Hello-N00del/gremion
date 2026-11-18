// @vitest-environment node
//
// locale-en unit, WCAG 3.1.2 (Language of Parts): the settings page is declared German
// (<html lang="de">, content-locale.ts) but renders its catalogue strings in the person's
// locale. Every such string has to sit under an element that says it is English; before
// this guard only the shell chrome carried a lang, so an English person read the Profile and
// Appearance tabs, the section navigation and the page head under an unmarked German page.
//
// The guard renders each section in both locales and takes the fragments that differ (the
// catalogue text): all of them must be under lang="en" in the English render. It also proves
// that it looks at something (the counts) and that a German person gets no lang="en" at all.
import { describe, expect, test, vi } from 'vitest'
import { render } from 'svelte/server'
import SettingsBody from './SettingsBody.svelte'
import { paraglideMiddleware } from '../../lib/i18n/paraglide/server.js'
import { defineCustomServerStrategy } from '../../lib/i18n/paraglide/runtime.js'
import { GREMION_STRATEGY, type Locale } from '../../lib/i18n/locale'
import { catalogueText, unchangedUnderLang, unmarkedCatalogueText } from '../../lib/i18n/lang-marks.testkit'

vi.mock('$app/environment', () => ({ browser: false, building: false, dev: true, version: 'test' }))
vi.mock('$app/navigation', () => ({ goto: vi.fn() }))
// The unit project resolves Svelte's client build, where onMount/onDestroy are refused outside a component.
vi.mock('svelte', async (importOriginal) => ({ ...(await importOriginal<typeof import('svelte')>()), onMount: () => {}, onDestroy: () => {} }))
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return { page: readable({ url: new URL('https://pilot.test/settings/profil'), form: null, data: {} }) }
})
vi.mock('$app/state', () => ({ page: { url: new URL('https://pilot.test/settings/profil'), form: null } }))

const localeOf = new WeakMap<Request, Locale>()
defineCustomServerStrategy(GREMION_STRATEGY, { getLocale: (request) => (request ? localeOf.get(request) : undefined) })

const data = {
  config: { org: { name: 'Gremium', domain: 'portal.example.test', logo_path: null }, brand: { term_months: null }, smtp: {}, legal: {}, compliance: {}, backups: { retention_days: 30, last_backup_at: null, encryption_key_path: '' } },
  isAdmin: true,
  isITAdmin: true,
  loeschkonzept: null,
  user: { name: 'E2E Admin', email: 'admin@example.test', groups: [] },
  profile: { firstName: 'A', lastName: 'B', email: 'a@example.test' },
  emailActionAvailable: true,
  accountUrl: null,
  mfaEnrolled: null,
  stepUpEnforced: false
}

async function settings(locale: Locale, activeSection: string): Promise<string> {
  const request = new Request('https://pilot.test/settings')
  localeOf.set(request, locale)
  const response = await paraglideMiddleware(
    request,
    () => new Response(render(SettingsBody, { props: { data: data as never, activeSection } }).body)
  )
  return await response.text()
}

// gefahrenzone is left out: its dialog widget does not render in this test environment, and the tab holds no catalogue text beyond the head and navigation every section shares.
const SECTIONS = ['profil', 'darstellung', 'organisation', 'module', 'dienste', 'email', 'rechtliches', 'datenschutz', 'sicherungen', 'loeschfristen']

describe('settings: catalogue text is marked with its language', () => {
  for (const section of SECTIONS) {
    test(`en, ${section}: every catalogue fragment sits under lang="en"`, async () => {
      const de = await settings('de', section)
      const en = await settings('en', section)
      // The page head and the section navigation are catalogue text in every section.
      expect(catalogueText(de, en).length, 'the guard sees catalogue text').toBeGreaterThan(10)
      const unmarked = unmarkedCatalogueText(de, en, 'en')
      expect(unmarked.map((f) => `${f.where} ${JSON.stringify(f.text)} (lang=${f.lang})`)).toEqual([])
    })
  }

  // The reverse: what is marked English must not be hard-coded German that reads the same in both renders.
  // Words spelt the same in both languages, and punctuation, are not German literals.
  const SAME_IN_BOTH = new Set(['Organisation', 'System', 'Backups', 'Name', 'Branding', 'Normal', 'Email', 'English'])
  test.each(SECTIONS)('en, %s: nothing marked lang="en" is a German literal', async (section) => {
    const de = await settings('de', section)
    const en = await settings('en', section)
    const suspects = unchangedUnderLang(de, en, 'en').filter((f) => /\p{L}{2,}/u.test(f.text) && !SAME_IN_BOTH.has(f.text))
    expect(suspects.map((f) => `${f.where} ${JSON.stringify(f.text)}`)).toEqual([])
  })

  // The language switch names each language in itself (lang="de" Deutsch, lang="en" English), so a German
  // person has exactly that one lang="en" on the appearance tab and none elsewhere.
  test('de: a German person gets no lang="en" beyond the English language name', async () => {
    expect((await settings('de', 'profil')).match(/lang="en"/g) ?? []).toHaveLength(0)
    expect((await settings('de', 'darstellung')).match(/lang="en"/g) ?? []).toHaveLength(1)
  })
})
