import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Finding 18a (2026-11 end-to-end test): in the dark theme the form field
// outline was nearly invisible. WCAG 1.4.11 asks a UI component boundary for
// 3:1 against the surrounding background. The ratio is computed here from the
// token values in app.css, so a later edit of a token cannot silently undo it.

const APP_CSS = readFileSync(join(__dirname, '..', '..', 'app.css'), 'utf8')

type Rgb = [number, number, number]

function block(selector: RegExp): string {
  return APP_CSS.match(selector)?.[1] ?? ''
}
const LIGHT = block(/:root\s*\{([\s\S]*?)\n\}/)
const DARK = block(/\n\.dark\s*\{([\s\S]*?)\n\}/)

function decl(css: string, name: string): string {
  const m = css.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))
  if (!m) throw new Error(`${name} is not declared`)
  return m[1].trim()
}

/** Resolve a token to a literal: follows `var(--x)` aliases within the same block. */
function resolve(css: string, name: string): string {
  let v = decl(css, name)
  for (let i = 0; i < 5; i++) {
    const alias = v.match(/^var\((--[\w-]+)\)$/)
    if (!alias) return v
    v = decl(css, alias[1])
  }
  throw new Error(`${name}: alias chain too long`)
}

function parse(value: string): { rgb: Rgb; a: number } {
  const hex = value.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], a: 1 }
  }
  const rgba = value.match(/^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/)
  if (rgba) return { rgb: [+rgba[1], +rgba[2], +rgba[3]], a: rgba[4] === undefined ? 1 : +rgba[4] }
  throw new Error(`unsupported colour literal: ${value}`)
}

function over(fg: { rgb: Rgb; a: number }, bg: Rgb): Rgb {
  return fg.rgb.map((c, i) => Math.round(c * fg.a + bg[i] * (1 - fg.a))) as Rgb
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const SURFACES = ['--paper', '--surface', '--surface-2'] as const
const FIELD_BACKGROUNDS = ['--paper', '--surface'] as const

describe('dark theme: form field outline meets WCAG 1.4.11 (3:1)', () => {
  for (const token of ['--border-strong', '--input']) {
    test(`${token} against every surface a field sits on`, () => {
      const outline = parse(resolve(DARK, token))
      const ratios: Record<string, number> = {}
      for (const field of FIELD_BACKGROUNDS) {
        const fieldBg = parse(resolve(DARK, field)).rgb
        // The outline is painted over the field's own background.
        const painted = over(outline, fieldBg)
        for (const surround of SURFACES) {
          const surroundBg = parse(resolve(DARK, surround)).rgb
          ratios[`${field} field on ${surround}`] = contrast(painted, surroundBg)
        }
      }
      const worst = Math.min(...Object.values(ratios))
      expect(worst, JSON.stringify(ratios)).toBeGreaterThanOrEqual(3)
    })
  }
})

describe('light theme tokens are unchanged', () => {
  test.each([
    ['--paper', '#fafaf7'],
    ['--surface', '#ffffff'],
    ['--border', 'rgba(22, 21, 19, 0.09)'],
    ['--border-strong', 'rgba(22, 21, 19, 0.16)'],
    ['--input', 'rgba(22, 21, 19, 0.09)']
  ])('%s', (name, literal) => {
    expect(resolve(LIGHT, name)).toBe(literal)
  })
})

describe('the dark card edge stays subtle', () => {
  test('--border (card edges, dividers) is not raised', () => {
    expect(decl(DARK, '--border')).toBe('rgba(237, 236, 231, 0.08)')
  })
})

describe('shared form controls use the input token', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', 'components', 'ui', rel), 'utf8')
  test.each([['input/input.svelte'], ['select/select.svelte']])('%s paints its outline with border-input', (rel) => {
    const src = read(rel)
    expect(src).toContain('border-input')
    expect(src).not.toMatch(/\bborder-border\b/)
  })
  test('app.css exposes --input as the border-input utility', () => {
    expect(APP_CSS).toMatch(/--color-input:\s*var\(--input\)/)
  })
})
