import { describe, it, expect, vi } from 'vitest'
import {
  TENANT_PALETTES,
  PALETTE_IDS,
  DEFAULT_ACCENT_HUE,
  instanceAccentVars,
  resolveAccentHue,
  resolvePaletteId,
  legacyAccentToPalette,
  isPaletteId,
  instanceThemeCss,
  instanceThemeStyleTag,
} from './instance-theme'

describe('instance-theme — #288 curated per-tenant accent', () => {
  describe('TENANT_PALETTES (LOCKED hues)', () => {
    it('pins the four curated hues from HANDOVER-v8 Part E', () => {
      expect(TENANT_PALETTES.stura.H).toBe(252)
      expect(TENANT_PALETTES.stadt.H).toBe(300)
      expect(TENANT_PALETTES.club.H).toBe(355)
      expect(TENANT_PALETTES.fara.H).toBe(200)
    })
    it('keeps every curated hue OUT of the warm danger/caution band (~20-60°)', () => {
      for (const p of Object.values(TENANT_PALETTES)) {
        expect(p.H < 20 || p.H > 60).toBe(true)
      }
    })
    it('uses the graphite default hue (design v10 Part D — decoupled from stura navy)', () => {
      expect(DEFAULT_ACCENT_HUE).toBe(265)
      // Graphite (265) is the kernel's neutral default; stura's navy (252) is now
      // a distinct curated palette, no longer coincident with the default.
      expect(TENANT_PALETTES.stura.H).toBe(252)
    })
  })

  describe('instanceAccentVars — mirrors the app.css --accent ramp formula', () => {
    it('derives all 8 ramp vars from a single hue (light + dark)', () => {
      const v = instanceAccentVars(300)
      expect(v.light).toEqual({
        '--accent': 'oklch(42% 0.11 300)',
        '--accent-ink': 'oklch(36% 0.11 300)',
        '--accent-soft': 'oklch(93% 0.035 300)',
        '--accent-faint': 'oklch(96% 0.02 300)',
      })
      expect(v.dark).toEqual({
        '--accent': 'oklch(72% 0.13 300)',
        '--accent-ink': 'oklch(78% 0.11 300)',
        '--accent-soft': 'oklch(28% 0.06 300)',
        '--accent-faint': 'oklch(22% 0.04 300)',
      })
    })
    it('matches the app.css navy values byte-for-byte at H=252', () => {
      // app.css :root --accent: oklch(42% 0.11 252); .dark --accent: oklch(72% 0.13 252)
      const v = instanceAccentVars(252)
      expect(v.light['--accent']).toBe('oklch(42% 0.11 252)')
      expect(v.light['--accent-soft']).toBe('oklch(93% 0.035 252)')
      expect(v.dark['--accent']).toBe('oklch(72% 0.13 252)')
      expect(v.dark['--accent-faint']).toBe('oklch(22% 0.04 252)')
    })
  })

  describe('resolveAccentHue — curated/hue-only input contract', () => {
    it('resolves a curated palette id to its hue (case-insensitive)', () => {
      expect(resolveAccentHue('stadt')).toBe(300)
      expect(resolveAccentHue('STURA')).toBe(252)
      expect(resolveAccentHue('club')).toBe(355)
      expect(resolveAccentHue('fara')).toBe(200)
    })
    it('resolves a bare hue number in [0,360]', () => {
      expect(resolveAccentHue('300')).toBe(300)
      expect(resolveAccentHue('252.5')).toBe(252.5)
      expect(resolveAccentHue('0')).toBe(0)
      expect(resolveAccentHue('360')).toBe(360)
    })
    it('reads the hue out of an oklch / hsl string', () => {
      expect(resolveAccentHue('oklch(42% 0.11 300)')).toBe(300)
      expect(resolveAccentHue('oklch(72% 0.13 200)')).toBe(200)
      expect(resolveAccentHue('hsl(355 40% 50%)')).toBe(355)
    })
    it('returns null for the default tenant (null / empty) — no injection', () => {
      expect(resolveAccentHue(null)).toBeNull()
      expect(resolveAccentHue(undefined)).toBeNull()
      expect(resolveAccentHue('')).toBeNull()
      expect(resolveAccentHue('   ')).toBeNull()
    })
    it('rejects a free-form hex (curated/hue-only is LOCKED) and warns', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(resolveAccentHue('#7c3aed')).toBeNull()
      expect(resolveAccentHue('rebeccapurple')).toBeNull()
      expect(resolveAccentHue('400')).toBeNull() // out of [0,360]
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  describe('instanceThemeCss / instanceThemeStyleTag — injection payload', () => {
    it('emits plain :root + .dark blocks (equal specificity to app.css)', () => {
      const css = instanceThemeCss(300)
      expect(css).toContain(':root{')
      expect(css).toContain('.dark{')
      expect(css).toContain('--accent:oklch(42% 0.11 300);')
      expect(css).toContain('--accent-faint:oklch(22% 0.04 300);')
      // NOT html.cb-* — must not out-specify the a11y overrides.
      expect(css).not.toContain('html.cb')
    })
    it('wraps the css in the canonical <style id="__instance-theme"> tag', () => {
      const tag = instanceThemeStyleTag('stadt')
      expect(tag.startsWith('<style id="__instance-theme">')).toBe(true)
      expect(tag.endsWith('</style>')).toBe(true)
      expect(tag).toContain('oklch(42% 0.11 300)')
    })
    it('emits an EMPTY string for the default tenant so injection is skipped', () => {
      expect(instanceThemeStyleTag(null)).toBe('')
      expect(instanceThemeStyleTag('')).toBe('')
    })
  })

  describe('isPaletteId / PALETTE_IDS — the id-only contract vocabulary', () => {
    it('recognizes exactly the four curated ids', () => {
      expect(PALETTE_IDS).toEqual(['stura', 'stadt', 'club', 'fara'])
      for (const id of PALETTE_IDS) expect(isPaletteId(id)).toBe(true)
    })
    it('rejects anything not in the registry', () => {
      expect(isPaletteId('gremion')).toBe(false)
      expect(isPaletteId('#7c3aed')).toBe(false)
      expect(isPaletteId('300')).toBe(false)
      expect(isPaletteId('')).toBe(false)
    })
  })

  describe('resolvePaletteId — gremion#22 id-only config/brand contract', () => {
    it('resolves a curated palette id (case/whitespace tolerant)', () => {
      expect(resolvePaletteId('stadt')).toBe('stadt')
      expect(resolvePaletteId('STURA')).toBe('stura')
      expect(resolvePaletteId('  fara  ')).toBe('fara')
    })
    it('returns null for the default tenant (null / empty)', () => {
      expect(resolvePaletteId(null)).toBeNull()
      expect(resolvePaletteId(undefined)).toBeNull()
      expect(resolvePaletteId('')).toBeNull()
      expect(resolvePaletteId('   ')).toBeNull()
    })
    it('rejects the deprecated freeform grammar (bare hue / oklch / hsl / hex) and warns', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(resolvePaletteId('300')).toBeNull()
      expect(resolvePaletteId('oklch(42% 0.11 300)')).toBeNull()
      expect(resolvePaletteId('hsl(355 40% 50%)')).toBeNull()
      expect(resolvePaletteId('#7c3aed')).toBeNull()
      expect(warn).toHaveBeenCalledTimes(4)
      warn.mockRestore()
    })
  })

  describe('legacyAccentToPalette — read-time migration of the retired brand.accent grammar', () => {
    it('maps a legacy value that is already a curated id onto itself', () => {
      expect(legacyAccentToPalette('stadt')).toBe('stadt')
      expect(legacyAccentToPalette('STURA')).toBe('stura')
    })
    it('maps a legacy bare hue onto the curated palette that owns it', () => {
      expect(legacyAccentToPalette('300')).toBe('stadt')
      expect(legacyAccentToPalette('252')).toBe('stura')
      expect(legacyAccentToPalette('355')).toBe('club')
      expect(legacyAccentToPalette('200')).toBe('fara')
    })
    it('maps a legacy oklch()/hsl() string by its hue component', () => {
      expect(legacyAccentToPalette('oklch(42% 0.11 300)')).toBe('stadt')
      expect(legacyAccentToPalette('hsl(200 40% 50%)')).toBe('fara')
    })
    it('null/empty stays null (no injection, no warning)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(legacyAccentToPalette(null)).toBeNull()
      expect(legacyAccentToPalette(undefined)).toBeNull()
      expect(legacyAccentToPalette('')).toBeNull()
      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
    })
    it('a hue with no curated owner drops to null and warns', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(legacyAccentToPalette('100')).toBeNull()
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })
    it('an outright-unparseable legacy value (hex) drops to null and warns', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(legacyAccentToPalette('#7c3aed')).toBeNull()
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })
  })
})
