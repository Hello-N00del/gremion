// @vitest-environment node
//
// TASK-062 TDD 6 (server half): a real legacy `$t` consumer, server-rendered
// inside Paraglide's request scope, comes out in the request's locale. Before
// TASK-062 the store returned 'de' whenever !browser, so an English request
// got German markup and flipped after hydration (the flash).
import { describe, expect, test, vi } from 'vitest'
import { render } from 'svelte/server'
import ThemeToggle from '$lib/components/layout/ThemeToggle.svelte'
import { paraglideMiddleware } from './paraglide/server.js'
import { defineCustomServerStrategy } from './paraglide/runtime.js'
import { GREMION_STRATEGY, type Locale } from './locale'

// SvelteKit's vitest integration reports browser=true here; this file is the
// server render, so pin the server branch of every browser-gated module.
vi.mock('$app/environment', () => ({ browser: false, building: false, dev: true, version: 'test' }))

const localeOf = new WeakMap<Request, Locale>()
defineCustomServerStrategy(GREMION_STRATEGY, { getLocale: (request) => (request ? localeOf.get(request) : undefined) })

async function ssr(locale: Locale): Promise<string> {
  const request = new Request('http://pilot.test/')
  localeOf.set(request, locale)
  const response = await paraglideMiddleware(request, () => new Response(render(ThemeToggle).body))
  return await response.text()
}

describe('legacy $t consumer rendered on the server (TASK-062 item 6)', () => {
  test('an en request renders English', async () => {
    const html = await ssr('en')
    expect(html).toContain('Colorblind mode')
    expect(html).toContain('Red-Green')
    expect(html).not.toContain('Farbenblind')
  })

  test('a de request renders German', async () => {
    const html = await ssr('de')
    expect(html).not.toContain('Colorblind mode')
    expect(html).toContain('Normal')
  })

  test('concurrent requests keep their own locale (no module-level state)', async () => {
    const [a, b] = await Promise.all([ssr('en'), ssr('de')])
    expect(a).toContain('Colorblind mode')
    expect(b).not.toContain('Colorblind mode')
  })

  test('no raw key reaches either render', async () => {
    for (const locale of ['de', 'en'] as const) {
      expect(await ssr(locale)).not.toMatch(/theme\.(cb|colorblind|light|dark)/)
    }
  })
})
