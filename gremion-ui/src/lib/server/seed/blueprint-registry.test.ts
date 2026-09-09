// P2.3 (#202) T3 — blueprint-registry unit tests.
// The pure ref → blueprint lookup the per-tenant seed path uses to feed a
// non-default tenant ITS OWN blueprint (instead of the hardcoded StuRa one).
import { describe, it, expect } from 'vitest'
import { resolveBlueprint, DEFAULT_BLUEPRINT_REF } from './blueprint-registry'
import { STURA_BLUEPRINT } from './org-blueprint'
import { MUNICIPAL_BLUEPRINT } from './municipal-blueprint'

describe('resolveBlueprint', () => {
  it('resolves the StuRa ref to the StuRa blueprint', () => {
    expect(resolveBlueprint('STURA_BLUEPRINT@1')).toBe(STURA_BLUEPRINT)
  })

  it('resolves the municipal ref to the municipal blueprint', () => {
    expect(resolveBlueprint('MUNICIPAL_BLUEPRINT@1')).toBe(MUNICIPAL_BLUEPRINT)
  })

  it('the default ref is the StuRa blueprint (default tenant stays StuRa)', () => {
    expect(resolveBlueprint(DEFAULT_BLUEPRINT_REF)).toBe(STURA_BLUEPRINT)
    expect(DEFAULT_BLUEPRINT_REF).toBe('STURA_BLUEPRINT@1')
  })

  it('throws loudly on an unknown ref (no silent fall-through to StuRa)', () => {
    expect(() => resolveBlueprint('NOPE@9')).toThrow(/unknown blueprint ref/i)
  })
})
