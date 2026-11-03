// @vitest-environment node
//
// Karenz phase 1, Task 12: the "Module" section of the settings page. It is admin-only (council-admin,
// which an it-admin includes), has its own deep link /settings/module and renders on the server like
// every other section. Kept apart from settings.test.ts: that file mocks fs and the config module for
// the API handlers, which would starve a component render.
import { describe, expect, test, vi } from 'vitest'
import { render } from 'svelte/server'
import SettingsBody from './SettingsBody.svelte'

vi.mock('$app/environment', () => ({ browser: false, building: false, dev: true, version: 'test' }))
vi.mock('$app/navigation', () => ({ goto: vi.fn() }))
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return { page: readable({ url: new URL('https://pilot.test/settings/module'), form: null, data: {} }) }
})
vi.mock('$app/state', () => ({ page: { url: new URL('https://pilot.test/settings/module'), form: null } }))

const data = (over: Record<string, unknown> = {}) => ({
  config: null,
  isAdmin: false,
  isITAdmin: false,
  loeschkonzept: null,
  user: { name: 'E2E Admin', email: 'admin@example.test', groups: [] },
  accountUrl: null,
  mfaEnrolled: null,
  stepUpEnforced: false,
  ...over,
})

describe('settings section "Module" (Karenz phase 1)', () => {
  test('the section is hidden for non-admins: no nav entry, and a deep link falls back to Profil', () => {
    const { body } = render(SettingsBody, { props: { data: data() as never, activeSection: 'module' } })
    expect(body).not.toMatch(/>\s*<span>Module<\/span>/)
    expect(body).not.toContain('data-testid="tab-modules"')
  })

  test('a council-admin sees the nav entry (in Verwaltung) and the section on the deep link', () => {
    const { body } = render(SettingsBody, { props: { data: data({ isAdmin: true }) as never, activeSection: 'module' } })
    expect(body).toMatch(/<span>Module<\/span>/)
    expect(body).toContain('data-testid="tab-modules"')
  })

  test('the alias route accepts "module" as a canonical section key', async () => {
    const { load } = await import('./[section]/+page.server')
    const parent = async () => ({})
    // @ts-expect-error partial event
    await expect(load({ params: { section: 'module' }, parent })).resolves.toEqual({ activeSection: 'module' })
    // @ts-expect-error partial event
    await expect(load({ params: { section: 'nope' }, parent })).rejects.toMatchObject({ status: 404 })
  })
})
