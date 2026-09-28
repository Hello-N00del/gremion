// @vitest-environment node
//
// TASK-062 post-condition 3 ("works with JS off"): the language switch must be
// in the SERVER-rendered HTML of /settings/darstellung, as a real form that
// posts to the `locale` action. Before this fix SettingsBody picked its
// section in an $effect, which never runs during SSR, so every deep link
// rendered the Profil section and the switch only appeared after hydration.
import { describe, expect, test, vi } from 'vitest'
import { render } from 'svelte/server'
import SettingsBody from '../../routes/settings/SettingsBody.svelte'

vi.mock('$app/environment', () => ({ browser: false, building: false, dev: true, version: 'test' }))
vi.mock('$app/navigation', () => ({ goto: vi.fn() }))
// Other tabs still import the legacy $app/stores; stub it so the client runtime is not loaded.
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return { page: readable({ url: new URL('https://pilot.test/settings/darstellung'), form: null, data: {} }) }
})
vi.mock('$app/state', () => ({ page: { url: new URL('https://pilot.test/settings/darstellung'), form: null } }))

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

describe('settings language switch in the SSR output (TASK-062, JS off)', () => {
  test('/settings/darstellung server-renders the locale form with both submit buttons', () => {
    const { body } = render(SettingsBody, { props: { data: data as never, activeSection: 'darstellung' } })
    expect(body).toMatch(/<form[^>]*method="POST"[^>]*action="\/settings\?\/locale"/)
    expect(body).toMatch(/<button[^>]*type="submit"[^>]*name="locale"[^>]*value="de"/)
    expect(body).toMatch(/<button[^>]*type="submit"[^>]*name="locale"[^>]*value="en"/)
    expect(body).toContain('name="redirectTo" value="/settings/darstellung"')
  })

  test('without a deep link the Profil section stays the default', () => {
    const { body } = render(SettingsBody, { props: { data: data as never } })
    expect(body).not.toContain('action="/settings?/locale"')
  })
})
