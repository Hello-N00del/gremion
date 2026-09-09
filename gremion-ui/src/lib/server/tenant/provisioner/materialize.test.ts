// P2.1c (T15) — materialize-config pure logic unit tests (no IO).
import { describe, it, expect } from 'vitest'
import {
  materializeConfig,
  brandIdentityComplete,
  assertBrandIdentityComplete,
} from './materialize'

describe('materializeConfig (defaults + stored -> fully-merged effective config)', () => {
  it('merges a stored partial onto the (neutral) defaults, producing a complete config', () => {
    const merged = materializeConfig({
      brand: { product: 'Musterrat', org_short: 'Muster-HS' },
      org: { name: 'Studierendenrat', domain: 'example.de' },
    })
    // brand identity comes from the stored file ...
    expect(merged.brand.product).toBe('Musterrat')
    expect(merged.brand.org_short).toBe('Muster-HS')
    // ... and fields the stored partial omits are back-filled from defaults.
    expect(merged.brand.logo_letter).toBe('P') // neutral default
    // Governance-only kernel: no always-on feature modules, so the default
    // modules map is empty (a stored partial that omits `modules` back-fills {}).
    expect(merged.modules).toEqual({})
    expect(merged.legal.impressum_html).toContain('per-tenant: set via config')
  })

  it('materializes an empty/absent stored config to the neutral defaults (no institution literal)', () => {
    const merged = materializeConfig({})
    expect(merged.brand.product).toBe('')
    expect(merged.brand.org_short).toBe('')
    // No HS-Harz anywhere in the materialized legal copy.
    expect(merged.legal.impressum_html).not.toMatch(/Hochschule Harz|stura\.hs-harz\.de/)
  })

  it('THROWS (loud) on a structurally-invalid stored config rather than silently defaulting', () => {
    expect(() => materializeConfig({ setup_complete: 'yes' })).toThrow()
  })
})

describe('brandIdentityComplete / assertBrandIdentityComplete (the §6-P2.2 boot guard)', () => {
  const complete = materializeConfig({
    brand: { product: 'Musterrat', org_short: 'Muster-HS' },
  })
  const blank = materializeConfig({})

  it('is true only when product AND org_short are both non-empty', () => {
    expect(brandIdentityComplete(complete)).toBe(true)
    expect(brandIdentityComplete(blank)).toBe(false)
    expect(
      brandIdentityComplete(materializeConfig({ brand: { product: 'Musterrat', org_short: '' } })),
    ).toBe(false)
  })

  it('treats whitespace-only identity as incomplete', () => {
    expect(
      brandIdentityComplete(materializeConfig({ brand: { product: '  ', org_short: 'x' } })),
    ).toBe(false)
  })

  it('assert passes for a complete brand and throws (loud, naming materialize-config) for a blank one', () => {
    expect(() => assertBrandIdentityComplete(complete, 'default')).not.toThrow()
    expect(() => assertBrandIdentityComplete(blank, 'default')).toThrow(/materialize-config/)
    expect(() => assertBrandIdentityComplete(blank, 'default')).toThrow(/default/)
  })
})
