// @vitest-environment node
//
// locale-en unit, WCAG 3.1.2: +error renders its messages from the catalogue, in the person's
// locale, on a page that is declared German (no route matched, content-locale.ts). Every
// English fragment has to sit under lang="en"; a message the server wrote itself is shown as
// it came and must not be marked as the person's language.
import { describe, expect, test, vi } from 'vitest'
import { render } from 'svelte/server'

const h = vi.hoisted(() => ({
  state: { status: 404, error: null as unknown, url: new URL('https://pilot.test/nope'), data: {} as Record<string, unknown> }
}))
vi.mock('$app/state', () => ({ page: h.state }))
vi.mock('$app/environment', () => ({ browser: false, building: false, dev: true, version: 'test' }))
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
// The unit project resolves Svelte's client build, where onMount is refused outside a component.
vi.mock('svelte', async (importOriginal) => ({ ...(await importOriginal<typeof import('svelte')>()), onMount: () => {} }))

import ErrorPage from './+error.svelte'
import { paraglideMiddleware } from '../lib/i18n/paraglide/server.js'
import { defineCustomServerStrategy } from '../lib/i18n/paraglide/runtime.js'
import { GREMION_STRATEGY, type Locale } from '../lib/i18n/locale'
import { catalogueText, unmarkedCatalogueText, fragmentsOf } from '../lib/i18n/lang-marks.testkit'

const localeOf = new WeakMap<Request, Locale>()
defineCustomServerStrategy(GREMION_STRATEGY, { getLocale: (request) => (request ? localeOf.get(request) : undefined) })

async function error(locale: Locale, status: number, message = 'x', data: Record<string, unknown> = {}): Promise<string> {
  h.state.status = status
  h.state.error = { message, errId: 'ERR-1' }
  h.state.data = data
  const request = new Request('https://pilot.test/nope')
  localeOf.set(request, locale)
  const response = await paraglideMiddleware(request, () => new Response(render(ErrorPage).body))
  return await response.text()
}

const session = { session: { user: { name: 'Mia Meier', roles: ['member'] } } }

describe('+error: catalogue text is marked with its language', () => {
  for (const [status, data] of [
    [404, {}],
    [403, session],
    [403, {}],
    [500, {}]
  ] as const) {
    test(`en, ${status}${data === session ? ' signed in' : ''}: every English fragment sits under lang="en"`, async () => {
      const de = await error('de', status, 'x', data)
      const en = await error('en', status, 'x', data)
      expect(catalogueText(de, en).length, 'the guard sees catalogue text').toBeGreaterThanOrEqual(3)
      expect(unmarkedCatalogueText(de, en, 'en').map((f) => `${f.where} ${JSON.stringify(f.text)} (lang=${f.lang})`)).toEqual([])
    })
  }

  test('a message the server wrote is not marked as English', async () => {
    const en = await error('en', 409, 'Konflikt beim Speichern')
    const detail = fragmentsOf(en).find((f) => f.text === 'Konflikt beim Speichern')
    expect(detail?.lang).toBe('de')
  })

  test('de: a German person gets no lang="en"', async () => {
    expect(await error('de', 404)).not.toContain('lang="en"')
  })
})
