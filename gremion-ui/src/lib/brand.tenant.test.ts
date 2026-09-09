import { describe, expect, it } from 'vitest'
import { DEFAULT_BRAND, resolveBrand } from './brand'

describe('brand.ts — neutral client fallback (no institution identity)', () => {
  it('DEFAULT_BRAND carries NO HS-Harz institution literals', () => {
    const s = JSON.stringify(DEFAULT_BRAND)
    expect(s).not.toMatch(/HS Harz/)
    expect(s).not.toMatch(/Hochschule Harz/)
    expect(s).not.toMatch(/stura\.hs-harz\.de/)
  })
  it('DEFAULT_BRAND is a usable neutral placeholder (no blank strings)', () => {
    // gremion#22: palette/logoUrl are nullable by design — null = today's
    // default rendering (app.css tokens + letter mark). Pin them to exactly
    // null; every other field stays a non-empty string.
    const NULLABLE = new Set(['palette', 'logoUrl'])
    for (const [k, v] of Object.entries(DEFAULT_BRAND)) {
      if (NULLABLE.has(k)) {
        expect(v, k).toBeNull()
        continue
      }
      expect(typeof v, k).toBe('string')
      expect((v as string).length, k).toBeGreaterThan(0)
    }
  })
  it('resolveBrand still merges a partial over the neutral defaults', () => {
    const b = resolveBrand({ orgShort: 'Stadt WR', product: 'GovOS' })
    expect(b.orgShort).toBe('Stadt WR')
    expect(b.product).toBe('GovOS')
    expect(b.domain).not.toBe('stura.hs-harz.de')
  })

  // P2.1c (T15 / §6-P2.2 finding B): empty/whitespace-only STRING fields are
  // treated as ABSENT — the worst case is the neutral 'Portal' fallback, never a
  // literally blank product/org name. (The neutralized DEFAULT_CONFIG.brand
  // resolves product/org_short to '' for an un-materialized tenant; without this
  // fix those '' values would override the placeholders.)
  it('empty-string brand fields fall through to the neutral Portal placeholders (not blank)', () => {
    const b = resolveBrand({ product: '', orgShort: '' })
    expect(b.product).toBe('Portal')
    expect(b.orgShort).toBe('Portal')
    // No field is left blank.
    expect(b.product.length).toBeGreaterThan(0)
    expect(b.orgShort.length).toBeGreaterThan(0)
  })

  it('whitespace-only brand fields also fall through to the neutral placeholders', () => {
    const b = resolveBrand({ product: '   ', orgName: '\t' })
    expect(b.product).toBe('Portal')
    expect(b.orgName).toBe('Portal')
  })

  it('a non-empty field still wins (the default/materialized tenant is byte-identical)', () => {
    const b = resolveBrand({ product: 'GovOS' })
    expect(b.product).toBe('GovOS')
  })

  it('preserves explicit null on nullable fields (palette/logoUrl) — empty-string rule is string-only', () => {
    const b = resolveBrand({ palette: null, logoUrl: null })
    expect(b.palette).toBeNull()
    expect(b.logoUrl).toBeNull()
    // A real palette id/logo is still passed through.
    const c = resolveBrand({ palette: 'stadt', logoUrl: 'https://cdn.example.org/l.svg' })
    expect(c.palette).toBe('stadt')
    expect(c.logoUrl).toBe('https://cdn.example.org/l.svg')
  })
})
