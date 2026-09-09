import { describe, it, expect } from 'vitest'
import { computeResult } from './compute-result'

// Governance Core INV-5 — DISPLAY-ONLY client mirror of the server rule
// (`evaluateMajority` in $lib/server/governance/decision-rule.ts). It exists so a
// draft ResolutionRow can show the same 'berechnet' verdict the server will
// persist, WITHOUT a round-trip and WITHOUT ever becoming the authority (the
// server recomputes on every write). It must mirror evaluateMajority EXACTLY,
// including the `&& yes+no>0` guard on two_thirds, so the two never disagree.
describe('computeResult (client mirror of evaluateMajority)', () => {
  it('simple: passed when yes > no, rejected on a tie or empty', () => {
    expect(computeResult(2, 1, 'simple', 10)).toBe('passed')
    expect(computeResult(2, 2, 'simple', 10)).toBe('rejected')
    expect(computeResult(0, 0, 'simple', 10)).toBe('rejected')
  })

  it('two_thirds: passed at exactly 2/3 of cast (yes >= 2*no && yes+no>0)', () => {
    expect(computeResult(2, 1, 'two_thirds', 10)).toBe('passed') // 2 of 3 cast
    expect(computeResult(3, 2, 'two_thirds', 10)).toBe('rejected') // 3 of 5 = 0.6
    expect(computeResult(4, 2, 'two_thirds', 10)).toBe('passed')
    // The verified case: a 5:3 two_thirds vote does NOT clear 2/3 → rejected.
    expect(computeResult(5, 3, 'two_thirds', 10)).toBe('rejected')
    // The `&& yes+no>0` guard: no votes cast can never pass two_thirds.
    expect(computeResult(0, 0, 'two_thirds', 10)).toBe('rejected')
  })

  it('absolute: passed only with more than half of ALL eligible members', () => {
    expect(computeResult(6, 0, 'absolute', 10)).toBe('passed')
    expect(computeResult(5, 0, 'absolute', 10)).toBe('rejected') // exactly half is not enough
    expect(computeResult(5, 4, 'absolute', 9)).toBe('passed')
  })
})
