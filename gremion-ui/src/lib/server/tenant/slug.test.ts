import { describe, it, expect } from 'vitest'
import { validateSlug, dbNameForSlug, RESERVED_SLUGS } from './slug'

describe('validateSlug', () => {
  it('accepts a simple lowercase slug', () => {
    expect(validateSlug('gemeinde')).toEqual({ ok: true, slug: 'gemeinde' })
  })
  it('accepts digits and internal hyphens', () => {
    expect(validateSlug('gemeinde-musterstadt-2')).toEqual({ ok: true, slug: 'gemeinde-musterstadt-2' })
  })
  it('rejects uppercase', () => {
    expect(validateSlug('StuRa').ok).toBe(false)
  })
  it('rejects underscores and dots', () => {
    expect(validateSlug('a_b').ok).toBe(false)
    expect(validateSlug('a.b').ok).toBe(false)
  })
  it('rejects empty and over-30-char slugs', () => {
    expect(validateSlug('').ok).toBe(false)
    expect(validateSlug('a'.repeat(31)).ok).toBe(false)
    expect(validateSlug('a'.repeat(30)).ok).toBe(true)
  })
  it('rejects reserved infra names', () => {
    for (const r of RESERVED_SLUGS) expect(validateSlug(r).ok).toBe(false)
  })
  it('refuses provisioning on an edge-owned satellite subdomain label (shadowed host)', () => {
    // FIX3-A: these labels are owned by satellite edge routers (gremion-public `public.`,
    // and the k8s cloud./matrix./elections. priority-20 routers) — a tenant provisioned
    // here would be status=active but its host routes AWAY from gremion-ui. Provisioning
    // must be refused at the slug guard. See RESERVED_SLUGS in slug.ts.
    for (const label of ['public', 'cloud', 'matrix', 'elections']) {
      expect(RESERVED_SLUGS).toContain(label)
      const r = validateSlug(label)
      expect(r.ok).toBe(false)
      expect(() => dbNameForSlug(label)).toThrow(/reserved/i)
    }
  })
  it('prefixes the physical DB name', () => {
    expect(dbNameForSlug('gemeinde')).toBe('t_gemeinde')
    expect(dbNameForSlug('gemeinde-x')).toBe('t_gemeinde-x')
  })
  it('dbNameForSlug throws on an invalid slug', () => {
    expect(() => dbNameForSlug('Bad Name')).toThrow(/invalid slug/i)
  })
})
