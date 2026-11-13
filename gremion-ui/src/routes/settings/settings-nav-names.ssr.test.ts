// @vitest-environment node
//
// E2E finding 17: the buttons of the settings navigation had no accessible
// names. Each one is an icon plus a label; the label is its name and the icon is
// decoration. The language switch (a group of two buttons) is named by its
// heading, not by one of its own buttons.
import { describe, expect, test, vi } from 'vitest'
import { render } from 'svelte/server'
import SettingsBody from './SettingsBody.svelte'

vi.mock('$app/environment', () => ({ browser: false, building: false, dev: true, version: 'test' }))
vi.mock('$app/navigation', () => ({ goto: vi.fn() }))
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return { page: readable({ url: new URL('https://pilot.test/settings/darstellung'), form: null, data: {} }) }
})
vi.mock('$app/state', () => ({ page: { url: new URL('https://pilot.test/settings/darstellung'), form: null } }))

const data = {
  config: null,
  isAdmin: true,
  isITAdmin: true,
  loeschkonzept: null,
  user: { name: 'E2E Admin', email: 'admin@example.test', groups: [] },
  accountUrl: null,
  mfaEnrolled: null,
  stepUpEnforced: false,
}

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

describe('settings navigation: accessible names', () => {
  const { body } = render(SettingsBody, { props: { data: data as never, activeSection: 'darstellung' } })
  const nav = /<nav class="set-nav"[\s\S]*?<\/nav>/.exec(body)?.[0] ?? ''
  const buttons = [...nav.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((m) => m[0])

  test('renders the navigation with its buttons (a vacuous walk would pass everything)', () => {
    expect(nav).toContain('aria-label="Einstellungsbereiche"')
    expect(buttons.length).toBeGreaterThanOrEqual(8)
  })

  test('every navigation button has a visible text as its name', () => {
    for (const button of buttons) {
      const label = text(button)
      expect(label.length, button).toBeGreaterThan(1)
      expect(label).not.toMatch(/^(badge|eye|settings|send|file|shield|folder|clock|lock)$/)
    }
  })

  test('the icons inside the buttons are hidden from assistive technology', () => {
    for (const button of buttons) {
      for (const svg of button.match(/<svg\b[^>]*>/g) ?? []) expect(svg, button).toContain('aria-hidden="true"')
    }
  })

  test('the current section is marked, and only it', () => {
    expect(buttons.filter((b) => b.includes('aria-current="page"'))).toHaveLength(1)
    expect(text(buttons.find((b) => b.includes('aria-current="page"')) ?? '')).toContain('Darstellung')
  })

  test('the language switch group is named by its own heading', () => {
    const group = /<form[^>]*role="group"[^>]*aria-labelledby="([^"]+)"/.exec(body)
    expect(group, 'language group').not.toBeNull()
    const id = group![1]!
    const labelled = new RegExp(`id="${id}"[^>]*>([^<]+)<`).exec(body)
    expect(labelled?.[1]?.trim().length ?? 0).toBeGreaterThan(1)
    // The heading is not one of the group's own buttons.
    expect(new RegExp(`<button[^>]*id="${id}"`).test(body)).toBe(false)
  })
})
