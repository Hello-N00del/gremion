// @vitest-environment node
//
// locale-en unit: switching the interface language to English changes the
// shell navigation. Before it, the rail's section and item labels were German
// literals shipped as data (nav-schema.ts, module manifests), so an English
// person read "Arbeitsbereich / Übersicht / Einstellungen" whatever the locale.
//
// The server render of the real shell over the real composed nav schema: with
// locale en the labels are English, with de they are the German originals, and
// a tenant's own term-map wording (retermNav) is left as the tenant wrote it.
import { describe, expect, test, vi } from 'vitest'
import { render } from 'svelte/server'

// SvelteKit's vitest integration reports browser=true here; this file is the
// server render, so pin the server branch of every browser-gated module.
vi.mock('$app/environment', () => ({ browser: false, building: false, dev: true, version: 'test' }))
vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  invalidate: vi.fn(),
  invalidateAll: vi.fn(),
  beforeNavigate: vi.fn(),
  onNavigate: vi.fn(),
  afterNavigate: vi.fn()
}))
vi.mock('$app/state', () => ({
  page: { url: new URL('http://pilot.test/settings'), data: {}, route: { id: '/settings' }, params: {} }
}))
// The unit project resolves Svelte's client build, where onMount is refused
// outside a component; on the server it is a no-op, which is what this stands in for.
vi.mock('svelte', async (importOriginal) => ({ ...(await importOriginal<typeof import('svelte')>()), onMount: () => {} }))
// $lib/stores/theme reads localStorage at import time; an in-memory stand-in.
vi.hoisted(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    }
  })
})

import AppShell from './AppShell.svelte'
import { navSchema, filterNavForSession, retermNav } from './nav-schema'
import { makeAuthHelpers } from '../../auth/group-helpers'
import { Role } from '../../auth'
import { paraglideMiddleware } from '../../i18n/paraglide/server.js'
import { defineCustomServerStrategy } from '../../i18n/paraglide/runtime.js'
import { GREMION_STRATEGY, type Locale } from '../../i18n/locale'

const localeOf = new WeakMap<Request, Locale>()
defineCustomServerStrategy(GREMION_STRATEGY, { getLocale: (request) => (request ? localeOf.get(request) : undefined) })

// A server-side snippet: svelte/server calls it with the renderer.
const children = ($$renderer: { push(html: string): void }) => $$renderer.push('<p>Seite</p>')
const everyRole = [Role.Guest, Role.Member, Role.CouncilAdmin, Role.ITAdmin]
const fullNav = () => filterNavForSession(navSchema, makeAuthHelpers({ user: { groups: [] } }), everyRole, new Set())

/** The shell rendered inside Paraglide's request scope, as the i18n handle does for a real request. */
async function shell(opts: { request: Locale; locale?: Locale; pageLocale?: Locale; nav?: ReturnType<typeof fullNav> }): Promise<string> {
  const request = new Request('http://pilot.test/settings')
  localeOf.set(request, opts.request)
  const props = { nav: opts.nav ?? fullNav(), roles: everyRole, userName: 'X', locale: opts.locale, pageLocale: opts.pageLocale, children }
  const response = await paraglideMiddleware(request, () => new Response(render(AppShell, { props }).body))
  return await response.text()
}

describe('the shell navigation follows the interface locale (server render)', () => {
  test('en: section and item labels are English', async () => {
    const html = await shell({ request: 'en', locale: 'en' })
    for (const label of ['Workspace', 'Overview', 'Calendar', 'Tasks', 'Documents', 'Committees', 'Minutes &amp; resolutions', 'Settings', 'System status', 'Administration', 'Members']) {
      expect(html, label).toContain(`>${label}<`)
    }
    // The rail itself (the top bar's breadcrumbs are a separate area).
    const rail = html.slice(html.indexOf('<nav class="sb-nav'), html.indexOf('</nav>', html.indexOf('<nav class="sb-nav')))
    expect(rail.length).toBeGreaterThan(200)
    for (const german of ['Arbeitsbereich', 'Übersicht', 'Kalender', 'Einstellungen', 'Systemstatus', 'Verwaltung', 'Mitglieder', 'Protokolle &amp; Beschlüsse']) {
      expect(rail, german).not.toContain(`>${german}<`)
    }
  })

  test('en: the accessible name and the rail tooltip label are English too', async () => {
    const html = await shell({ request: 'en', locale: 'en' })
    expect(html).toContain('aria-label="Settings"')
    expect(html).toContain('data-nav-label="Settings"')
    expect(html).not.toContain('aria-label="Einstellungen"')
  })

  test('de: the German originals', async () => {
    const html = await shell({ request: 'de', locale: 'de' })
    for (const label of ['Arbeitsbereich', 'Übersicht', 'Kalender', 'Einstellungen', 'Systemstatus', 'Verwaltung', 'Mitglieder']) {
      expect(html, label).toContain(`>${label}<`)
    }
    expect(html).not.toContain('>Workspace<')
  })

  test('no locale prop follows the request locale', async () => {
    expect(await shell({ request: 'de' })).toContain('>Arbeitsbereich<')
    expect(await shell({ request: 'en' })).toContain('>Workspace<')
  })

  test("a tenant's own wording (term-map) is left as the tenant wrote it", async () => {
    const nav = retermNav(fullNav(), { gremien: 'Fachschaftsräte', navCommittees: 'Fachschaften' })
    const html = await shell({ request: 'en', locale: 'en', nav })
    expect(html).toContain('>Fachschaftsräte<')
    expect(html).toContain('>Fachschaften<')
    expect(html).toContain('>Overview<')
  })
})

/** The opening tag of the navigation column. */
const columnTag = (html: string) => /<div[^>]*nav-col[^>]*>/.exec(html)?.[0] ?? 'NO NAV COLUMN'

describe('language of parts (WCAG 3.1.2): chrome that differs from the page is marked', () => {
  test('English chrome around a German-declared page carries lang="en"', async () => {
    const html = await shell({ request: 'en', locale: 'en', pageLocale: 'de' })
    expect(columnTag(html)).toMatch(/\blang="en"/)
    // The hamburger is chrome too (it only shows below the column breakpoint).
    expect(/<button[^>]*nav-hamburger[^>]*>/.exec(html)?.[0]).toMatch(/\blang="en"/)
  })

  test('chrome in the page language needs no lang attribute', async () => {
    const html = await shell({ request: 'de', locale: 'de', pageLocale: 'de' })
    expect(columnTag(html)).not.toMatch(/\blang=/)
  })
})
