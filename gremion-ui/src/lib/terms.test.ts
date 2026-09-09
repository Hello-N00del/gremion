import { describe, expect, it } from 'vitest'
import { termFor } from './terms'
import { configUpdateSchema, parseConfig, gremionConfigSchema } from './server/config'

// P2.2-data Task 11 — tenant term-map DATA model (design §3.5(e): display
// labels only; stable internal IDs never change). Consumption at the
// role-filter sites is P2.2-auth (after the P2.1b merge) — here we pin the
// pure lookup helper + the config schema carrying the map.

describe('termFor', () => {
  it('returns the fallback when the term map has no override', () => {
    expect(termFor({}, 'role.council-admin', 'Vorstand')).toBe('Vorstand')
  })

  it('returns the tenant override when present', () => {
    expect(
      termFor({ 'role.council-admin': 'Bürgermeister' }, 'role.council-admin', 'Vorstand'),
    ).toBe('Bürgermeister')
  })

  it('returns the fallback when the term map is undefined (config omits terms)', () => {
    expect(termFor(undefined, 'role.council-admin', 'Vorstand')).toBe('Vorstand')
  })

  // D6 (design v11): a `null` fallback turns the lookup into a PRESENCE GATE —
  // the Fraktions-Panel renders only when the tenant defines a caucus term.
  describe("presence gate: termFor(terms, 'fraktionen', null)", () => {
    it('stays null for a tenant without the key (StuRa: panel disappears)', () => {
      expect(termFor({}, 'fraktionen', null)).toBeNull()
      expect(termFor({ gremien: 'Ausschüsse' }, 'fraktionen', null)).toBeNull()
    })

    it('stays null when the whole map is absent', () => {
      expect(termFor(undefined, 'fraktionen', null)).toBeNull()
    })

    it("returns the tenant's caucus term when defined (municipal: panel + heading)", () => {
      expect(termFor({ fraktionen: 'Fraktionen' }, 'fraktionen', null)).toBe('Fraktionen')
    })
  })
})

describe('config schema: terms', () => {
  it('gremionConfigSchema parses a config carrying a terms map and preserves it', () => {
    const result = gremionConfigSchema.safeParse({ terms: { 'role.member': 'Ratsmitglied' } })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.terms).toEqual({ 'role.member': 'Ratsmitglied' })
    }
  })

  it('rejects a non-string term value', () => {
    const result = gremionConfigSchema.safeParse({ terms: { 'role.member': 42 } })
    expect(result.success).toBe(false)
  })

  it('configUpdateSchema (.strict()) accepts terms as a known key', () => {
    const result = configUpdateSchema.safeParse({ terms: { 'role.member': 'Ratsmitglied' } })
    expect(result.success).toBe(true)
  })

  it('parseConfig surfaces the stored terms map on the full config', () => {
    const cfg = parseConfig({ terms: { 'role.member': 'Ratsmitglied' } })
    expect(cfg.terms).toEqual({ 'role.member': 'Ratsmitglied' })
  })

  it('DEFAULT_CONFIG omits terms — StuRa tenant has no overrides (stable internal IDs)', () => {
    const cfg = parseConfig({})
    expect(cfg.terms).toBeUndefined()
  })
})
