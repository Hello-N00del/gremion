import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import config from '../../../svelte.config.js'

// Nonce-based CSP: SvelteKit owns the policy for page renders (svelte.config.js kit.csp)
// and stamps a per-response nonce on every inline script it injects. It does NOT nonce
// scripts written in the app.html template: those must carry %sveltekit.nonce% by hand,
// or the browser blocks them once 'unsafe-inline' is gone from script-src.
//
// These are source-shape guards. They cannot see a runtime violation: the e2e smoke
// (tests/e2e/smoke.spec.ts) is the guard that proves a built app still hydrates.

// __dirname = src/lib/test, so ../../ = src/
const APP_HTML = readFileSync(join(__dirname, '../../app.html'), 'utf8')

describe('app.html: hand-written inline scripts carry the CSP nonce', () => {
  const openTags = [...APP_HTML.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])

  test('app.html still carries at least one inline script (the guard is not vacuous)', () => {
    expect(openTags.length).toBeGreaterThan(0)
  })

  test('every <script> tag in app.html carries the sveltekit nonce placeholder', () => {
    const missing = openTags.filter((tag) => !tag.includes('nonce="%sveltekit.nonce%"'))
    expect(missing).toEqual([])
  })
})

describe('svelte.config.js kit.csp', () => {
  type Csp = { mode?: string; directives?: Record<string, string[]> }
  const csp = (config.kit as { csp?: Csp } | undefined)?.csp
  const directives = csp?.directives ?? {}

  test('is configured in auto mode (header on SSR pages, meta on prerendered ones)', () => {
    expect(csp?.mode).toBe('auto')
  })

  test("script-src is 'self' only: SvelteKit adds the nonce, and 'unsafe-inline' must not return", () => {
    expect(directives['script-src']).toEqual(['self'])
  })

  test("default-src comes first (the running-system checks anchor on `default-src 'self'; `)", () => {
    expect(Object.keys(directives)[0]).toBe('default-src')
    expect(directives['default-src']).toEqual(['self'])
  })

  test("style-src keeps 'unsafe-inline' (scoped styles and utility classes emit inline style attributes)", () => {
    expect(directives['style-src']).toEqual(['self', 'unsafe-inline'])
  })

  test('the baseline hardening directives are present', () => {
    expect(directives['object-src']).toEqual(['none'])
    expect(directives['base-uri']).toEqual(['self'])
    expect(directives['form-action']).toEqual(['self'])
    expect(directives['frame-src']).toEqual(['self'])
  })

  test('frame-ancestors is NOT here: a meta CSP ignores it, so hooks.server.ts sets it as a header', () => {
    expect(directives['frame-ancestors']).toBeUndefined()
  })
})
