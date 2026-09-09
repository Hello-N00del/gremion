// P2.2-auth A4 (D-CONST) — composePageAccess/composeCapabilities vocabulary seam.
// The compose functions gain an OPTIONAL tenant role-vocabulary argument
// (D-VOCAB seam). Composition is vocabulary-INDEPENDENT today — manifest pages
// and capabilities are static declarations and per-tenant shaping is P2.3 —
// so these tests pin (a) the no-arg path stays the golden default and (b) a
// vocabulary arg changes NOTHING about the composed content yet (the seam is
// threading-only, same posture as decode.ts in A3). The pre-existing golden
// pins live in registry.test.ts and stay UNTOUCHED.
import { describe, it, expect } from 'vitest'
import { composePageAccess, composeCapabilities } from './registry'

const NARROWED: readonly string[] = ['guest', 'member', 'buergermeister']

describe('composePageAccess(vocabulary?) — tenant-arg seam (P2.2-auth A4)', () => {
  it('an explicit undefined vocabulary equals the golden no-arg composition', () => {
    expect(composePageAccess(undefined)).toEqual(composePageAccess())
  })

  it('composition is vocabulary-INDEPENDENT today (P2.3 owns per-tenant shaping)', () => {
    expect(composePageAccess(NARROWED)).toEqual(composePageAccess())
    expect(composePageAccess([])).toEqual(composePageAccess())
  })

  it('every call returns a fresh map (no shared mutable object across tenants)', () => {
    expect(composePageAccess(NARROWED)).not.toBe(composePageAccess(NARROWED))
    expect(composePageAccess()).not.toBe(composePageAccess())
  })
})

describe('composeCapabilities(vocabulary?) — tenant-arg seam (P2.2-auth A4)', () => {
  it('an explicit undefined vocabulary equals the golden no-arg composition', () => {
    expect(composeCapabilities(undefined)).toEqual(composeCapabilities())
  })

  it('composition is vocabulary-INDEPENDENT today (capabilities are GROUP-keyed; a role vocabulary has no defined projection onto groups until P2.3)', () => {
    expect(composeCapabilities(NARROWED)).toEqual(composeCapabilities())
    expect(composeCapabilities([])).toEqual(composeCapabilities())
  })

  it('every call returns a fresh map (no shared mutable object across tenants)', () => {
    expect(composeCapabilities(NARROWED)).not.toBe(composeCapabilities(NARROWED))
    expect(composeCapabilities()).not.toBe(composeCapabilities())
  })
})
