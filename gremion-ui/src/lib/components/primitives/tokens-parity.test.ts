// Accent parity between the app's curated palettes and the token build
// (TASK-082 brief section 6 item 3a, UX-033 "kept"): for every
// TENANT_PALETTES hue, the build's per-palette override set equals
// instanceAccentVars(H), the function hooks.server.ts injects at runtime,
// byte for byte, light and dark; and the default tenant is NOT the engine's
// output for the default hue (it renders the app.css graphite literals).
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildPalettes, parseStrictJson } from '@gremion/tokens'

import { TENANT_PALETTES, DEFAULT_ACCENT_HUE, instanceAccentVars, instanceThemeCss } from '$lib/theme/instance-theme'

// Under jsdom import.meta.url is not a file: URL, so read the JSON by path.
const TOKEN_FILE = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'tokens', 'tokens', 'gremion.tokens.json')
const base = parseStrictJson(readFileSync(TOKEN_FILE, 'utf8'), TOKEN_FILE) as Record<string, unknown>
const palettes = buildPalettes(base)

describe('token build <-> runtime accent injection', () => {
  test('every curated TENANT_PALETTES hue is a palette hue of the token file, and nothing else is', () => {
    const appHues = Object.values(TENANT_PALETTES)
      .map((p) => p.H)
      .sort((a, b) => a - b)
    const tokenHues = Object.values(palettes)
      .map((p) => p.H)
      .sort((a, b) => a - b)
    expect(tokenHues).toEqual(appHues)
    expect(appHues.length).toBe(4)
  })

  test('per TENANT_PALETTES hue, the emitted overrides equal instanceAccentVars(H), light and dark', () => {
    for (const [id, p] of Object.entries(TENANT_PALETTES)) {
      const built = Object.values(palettes).find((b) => b.H === p.H)
      expect(built, id).toBeDefined()
      const want = instanceAccentVars(p.H)
      expect(built?.light, `${id} light`).toEqual(want.light)
      expect(built?.dark, `${id} dark`).toEqual(want.dark)
      // The injected <style> body is made of the same declarations.
      const css = instanceThemeCss(p.H)
      for (const [k, v] of Object.entries(want.light)) expect(css).toContain(`${k}:${v};`)
    }
  })

  test('the default hue is not injected through the engine: the graphite literals render instead', () => {
    expect(DEFAULT_ACCENT_HUE).toBe(265)
    expect(Object.values(palettes).some((b) => b.H === DEFAULT_ACCENT_HUE)).toBe(false)
    const appCss = readFileSync(join(__dirname, '..', '..', '..', 'app.css'), 'utf8')
    expect(appCss).toContain('--accent: oklch(42% 0.0154 265);')
    expect(appCss).not.toContain(`--accent: ${instanceAccentVars(DEFAULT_ACCENT_HUE).light['--accent']};`)
  })
})
