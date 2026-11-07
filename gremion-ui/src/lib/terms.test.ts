import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { termFor } from './terms'
import { ROLE_LABELS } from './auth/labels'
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

  // Karenz phase 1 (Task 7, round-2 item 4): "Vorstand" is now its own role, so the dashboard's
  // council-admin term defaults to the council-admin role label, not the literal 'Vorstand'.
  it("dashboard: the councilAdmin term defaults to \"Gremienverwaltung\" and no 'Vorstand' literal default remains in src/routes/+page.svelte", () => {
    const SRC = readFileSync(resolve(process.cwd(), 'src/routes/+page.svelte'), 'utf8')
    expect(SRC.length).toBeGreaterThan(500) // a zero-byte read would vacuously pass
    expect(SRC).toContain("termFor(terms, 'councilAdmin', ROLE_LABELS['council-admin'])")
    expect(SRC).not.toMatch(/termFor\(terms, 'councilAdmin', 'Vorstand'\)/)
    expect(SRC).not.toMatch(/['"]Vorstand['"]/)
    expect(termFor(undefined, 'councilAdmin', ROLE_LABELS['council-admin'])).toBe('Gremienverwaltung')
    expect(termFor({ councilAdmin: 'Buergermeister' }, 'councilAdmin', ROLE_LABELS['council-admin'])).toBe('Buergermeister')
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
    expect(result.success && result.data.terms).toEqual({ 'role.member': 'Ratsmitglied' })
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
