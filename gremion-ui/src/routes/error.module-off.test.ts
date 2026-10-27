import { describe, test, expect, vi } from 'vitest'
import { render } from '@testing-library/svelte'

// R33c UX-1 guard (component level): a client-side navigation to a disabled module (403 'module-disabled:<id>')
// renders the styled German "Modul nicht aktiv" surface and never the raw code string. The shell comes from
// +layout.svelte; the full-page-load path is answered by the authGuard hook (pinned in hooks.module-gate.test.ts and lib/server/module-off-response.test.ts).
const h = vi.hoisted(() => ({
  state: { status: 403, error: null as unknown, url: new URL('http://localhost/files'), data: {} as Record<string, unknown> },
}))
vi.mock('$app/state', () => ({ page: h.state }))
vi.mock('$app/paths', () => ({ base: '', assets: '', resolve: (p: string) => p }))
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return { page: readable(h.state) }
})
vi.mock('$lib/stores/theme', async () => {
  const { writable } = await import('svelte/store')
  return { themeMode: writable('light'), initTheme: () => {} }
})
vi.mock('$env/dynamic/public', () => ({ env: {} }))
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as never
}

import ErrorPage from './+error.svelte'

function mount(roles: string[]) {
  h.state.status = 403
  h.state.error = { message: 'module-disabled:files' }
  h.state.data = { session: { user: { name: 'Mia Meier', roles } } }
  return render(ErrorPage)
}

describe('module-disabled 403 surface', () => {
  test('styled page with the module display name, no raw code, inside the shell', () => {
    const { container } = mount(['member'])
    const text = container.textContent ?? ''
    expect(text).toContain('Modul nicht aktiv')
    expect(text).toContain("Das Modul Dateien")
    expect(text).not.toContain('module-disabled')
    expect(container.querySelector('[data-testid="module-off"]')).toBeTruthy()
    // The kernel has no /dashboard route: its home is '/'. The notice's own escape link must point there.
    const noticeHrefs = Array.from(container.querySelectorAll('[data-testid="module-off"] a')).map((a) => a.getAttribute('href'))
    expect(noticeHrefs).toContain('/')
    expect(noticeHrefs).not.toContain('/dashboard')
  })

  test('non-admins get no admin hint, admins do', () => {
    expect(mount(['member']).container.textContent).not.toContain('Module verwalten')
    const admin = mount(['it-admin'])
    expect(admin.container.textContent).toContain('Module verwalten')
    expect(admin.container.textContent).toContain('einschalten')
  })
})
