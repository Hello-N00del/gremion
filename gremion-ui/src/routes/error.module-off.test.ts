import { describe, test, expect, vi } from 'vitest'
import { render } from '@testing-library/svelte'
import type { NavItem } from '$lib/components/layout/nav-schema'

// R33c UX-1 guard: a disabled module's page deep link (403 'module-disabled:<id>') must render the styled
// German "Modul nicht aktiv" surface INSIDE the app shell (rail visible, link back to the dashboard) and must
// never show the raw code string. Revert guard: in +error.svelte drop the `{#if moduleOff && shell && shell.user}`
// AppShell branch (or in ModuleOffNotice.svelte print the id) and this goes RED.
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

const nav: NavItem[] = [{ kind: 'item', href: '/dashboard', label: 'Home' }]
const shell = (roles: string[]) => ({
  nav,
  brand: null,
  sourceUrl: undefined,
  modules: { files: false, messages: true },
  user: { name: 'Mia Meier', roles, groups: [] },
})

function mount(roles: string[]) {
  h.state.status = 403
  h.state.error = { message: 'module-disabled:files', shell: shell(roles) }
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
    expect(container.querySelector('nav')).toBeTruthy()
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/dashboard')
  })

  test('non-admins get no admin hint, admins do', () => {
    expect(mount(['member']).container.textContent).not.toContain('Module verwalten')
    const admin = mount(['it-admin'])
    expect(admin.container.textContent).toContain('Module verwalten')
    expect(admin.container.textContent).toContain('einschalten')
  })
})
