// @vitest-environment node
//
// locale-en unit, WCAG 3.1.2: the top bar's controls carry the chrome's language when it differs
// from the page's. The instance badge keeps its German wording ("INSTANZ · ...", a label the
// catalogue does not reach), so inside the link that is marked English for its title the text is
// marked German instead of being read with English pronunciation.
import { describe, expect, test, vi } from 'vitest'
import { render } from 'svelte/server'

vi.mock('$app/environment', () => ({ browser: false, building: false, dev: true, version: 'test' }))
vi.mock('$app/navigation', () => ({ goto: vi.fn() }))
vi.mock('$app/state', () => ({
  page: { url: new URL('https://pilot.test/settings'), data: { instanceState: 'degraded' }, route: { id: '/settings' }, params: {} }
}))
// The unit project resolves Svelte's client build, where onMount is refused outside a component.
vi.mock('svelte', async (importOriginal) => ({ ...(await importOriginal<typeof import('svelte')>()), onMount: () => {} }))
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

import TopBar from './TopBar.svelte'
import { paraglideMiddleware } from '../../i18n/paraglide/server.js'
import { defineCustomServerStrategy } from '../../i18n/paraglide/runtime.js'
import { GREMION_STRATEGY, type Locale } from '../../i18n/locale'

const localeOf = new WeakMap<Request, Locale>()
defineCustomServerStrategy(GREMION_STRATEGY, { getLocale: (request) => (request ? localeOf.get(request) : undefined) })

async function topbar(locale: Locale, lang?: string): Promise<string> {
  const request = new Request('https://pilot.test/settings')
  localeOf.set(request, locale)
  const response = await paraglideMiddleware(request, () => new Response(render(TopBar, { props: { nav: [], lang } }).body))
  return await response.text()
}

describe('top bar language marks', () => {
  test('en: the instance badge is marked English for its title and German for its text', async () => {
    const html = await topbar('en', 'en')
    expect(html).toMatch(/<a href="\/systemstatus"[^>]*\blang="en"[^>]*title="Provisioning &amp; convergence/)
    expect(html).toMatch(/<span class="inst-txt[^"]*" lang="de">INSTANZ · /)
  })

  test('en: the search button, theme toggle and logout carry lang="en"', async () => {
    const html = await topbar('en', 'en')
    expect(html.match(/lang="en"/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  })
})
