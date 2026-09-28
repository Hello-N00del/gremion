// @vitest-environment node
//
// TASK-062 TDD 5 / brief Q1: "a write failure is surfaced to the person".
// The switch form posts to /settings?/locale. When the preference write fails,
// switchLocale returns fail(503, { localeError: 'not-saved' }) and SvelteKit
// renders the /settings page itself (not the /settings/darstellung deep link)
// with that action result as `form`. The alert lives in the Darstellung
// section, so the /settings page must open that section when the switch
// failed. Otherwise the person lands on Profil and never sees the error.
import { describe, expect, test, vi } from 'vitest'
import { render } from 'svelte/server'
import SettingsPage from '../../routes/settings/+page.svelte'

const state = vi.hoisted(() => ({ form: null as Record<string, unknown> | null }))

vi.mock('$app/environment', () => ({ browser: false, building: false, dev: true, version: 'test' }))
vi.mock('$app/navigation', () => ({ goto: vi.fn() }))
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return { page: readable({ url: new URL('https://pilot.test/settings'), form: null, data: {} }) }
})
vi.mock('$app/state', () => ({
  page: {
    url: new URL('https://pilot.test/settings'),
    data: {},
    get form() {
      return state.form
    }
  }
}))

const data = {
  config: null,
  isAdmin: false,
  isITAdmin: false,
  loeschkonzept: null,
  user: { name: 'E2E Locale', email: 'e2e-locale@example.test', groups: [] },
  accountUrl: null,
  mfaEnrolled: null,
  stepUpEnforced: false
}

function renderSettings(form: Record<string, unknown> | null): string {
  state.form = form
  return render(SettingsPage, { props: { data: data as never, form: form as never } }).body
}

describe('/settings after a failed language switch (TASK-062, JS off)', () => {
  test('a not-saved failure opens Darstellung and shows the alert', () => {
    const body = renderSettings({ localeError: 'not-saved', locale: 'en' })
    expect(body).toMatch(/<p[^>]*role="alert"[^>]*>[^<]*konnte aber nicht in Ihrem Konto gespeichert werden/)
    expect(body).toContain('action="/settings?/locale"')
  })

  test('an invalid-locale failure opens Darstellung and shows the alert', () => {
    const body = renderSettings({ localeError: 'invalid' })
    expect(body).toMatch(/<p[^>]*role="alert"[^>]*>[^<]*Diese Sprache wird nicht unterstützt/)
  })

  test('without an action result /settings still opens Profil', () => {
    const body = renderSettings(null)
    expect(body).not.toContain('role="alert"')
    expect(body).not.toContain('action="/settings?/locale"')
  })
})
