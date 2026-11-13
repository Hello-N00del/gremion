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
