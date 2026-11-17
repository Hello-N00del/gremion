// @vitest-environment node
//
// Settings > Organisation: SettingsBody must hand the stored brand.term_months to the form, so an
// IT admin of a customer that already has semester months sees them preselected (and is not offered
// "nicht festgelegt"). Pins the prop wiring in SettingsBody, which the TabGeneral logic alone does not.
// Kept apart from settings.test.ts for the same reason as modules-section.ssr.test.ts.
import { describe, expect, test, vi } from 'vitest'
import { render } from 'svelte/server'
import SettingsBody from './SettingsBody.svelte'

vi.mock('$app/environment', () => ({ browser: false, building: false, dev: true, version: 'test' }))
vi.mock('$app/navigation', () => ({ goto: vi.fn() }))
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return { page: readable({ url: new URL('https://pilot.test/settings/organisation'), form: null, data: {} }) }
})
vi.mock('$app/state', () => ({ page: { url: new URL('https://pilot.test/settings/organisation'), form: null } }))

const data = (brand: Record<string, unknown> | undefined) => ({
  config: { org: { name: 'Beispiel', domain: 'example.org', logo_path: null }, brand },
  isAdmin: true,
  isITAdmin: true,
  loeschkonzept: null,
  user: { name: 'E2E Admin', email: 'admin@example.test', groups: [] },
  mfaEnrolled: null,
  stepUpEnforced: false,
})

/** The `<select id=...>` element with its options, as raw markup. */
function selectOf(markup: string, id: string): string {
  const m = markup.match(new RegExp(`<select id="${id}"[^>]*>[\\s\\S]*?</select>`))
  if (!m) throw new Error(`no <select id="${id}"> in the Organisation section`)
  return m[0]
}

function selectedValue(select: string): string | null {
  return select.match(/<option value="(\d+)"[^>]*\bselected\b/)?.[1] ?? null
}

describe('settings section "Organisation": semester months', () => {
  test('the stored brand.term_months arrive in the two selects, with no "nicht festgelegt" option', () => {
    const { body } = render(SettingsBody, {
      props: { data: data({ term_months: { winter: 9, summer: 3 } }) as never, activeSection: 'organisation' },
    })
    const winter = selectOf(body, 'g-term-winter')
    const summer = selectOf(body, 'g-term-summer')
    expect(selectedValue(winter)).toBe('9')
    expect(selectedValue(summer)).toBe('3')
    expect(winter).not.toContain('nicht festgelegt')
    expect(summer).not.toContain('nicht festgelegt')
  })

  test('a customer without months is offered "nicht festgelegt" and nothing preselected', () => {
    const { body } = render(SettingsBody, { props: { data: data(undefined) as never, activeSection: 'organisation' } })
    for (const id of ['g-term-winter', 'g-term-summer']) {
      const s = selectOf(body, id)
      expect(s).toContain('nicht festgelegt')
      expect(selectedValue(s)).toBeNull()
    }
  })
})

// No logo upload exists in Settings. The page must not promise one: neither the section
// subtitle nor the form text.
describe('settings section "Organisation": no logo promise', () => {
  test('neither the subtitle nor the branding text mentions a logo', () => {
    const { body } = render(SettingsBody, { props: { data: data(undefined) as never, activeSection: 'organisation' } })
    expect(body).not.toMatch(/logo/i)
  })
})

// The organisation name feeds only the browser-tab title (brand.orgName -> page-title). The header
// shows the product/short name and the public portal takes its name from deployment config, so the
// branding text must not promise either place. Checked on the rendered German page and on both
// locale files, so a revert of de.json or en.json alone turns it red.
describe('settings section "Organisation": branding text says only what is true', () => {
  const FALSE_PLACES = /Kopfzeile|Portal|Header|header|E-Mail|e-?mail/

  test('the rendered branding text names the browser tab and no other place', () => {
    const { body } = render(SettingsBody, { props: { data: data(undefined) as never, activeSection: 'organisation' } })
    const sub = body.match(/<p class="text-xs text-ink-muted">(Name der Studierendenschaft[^<]*)<\/p>/)?.[1]
    expect(sub, 'branding sub text not found').toBeDefined()
    expect(sub).toMatch(/Browser/)
    expect(sub).not.toMatch(FALSE_PLACES)
  })

  test.each(['de', 'en'])('%s.json settings.org.branding.sub does not claim header, portal or e-mail', async (lang) => {
    const msgs = (await import(`../../lib/i18n/messages/${lang}.json`)).default as Record<string, string>
    const sub = msgs['settings.org.branding.sub']
    expect(sub).toMatch(/browser/i)
    expect(sub).not.toMatch(FALSE_PLACES)
    expect(sub).not.toMatch(/logo/i)
  })
})
