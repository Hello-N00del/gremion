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

  // Phase-2 decision-rule registry (charter §8 item 5): consent and
  // support_threshold are mirrored case-for-case from the server registry's
  // semantics — extended IN this module (per its header contract), never forked
  // into a second client rule module.
  it('consent: passed iff there are NO objections — one Nein blocks, silence adopts', () => {
    expect(computeResult(5, 0, 'consent', 10)).toBe('passed')
    expect(computeResult(5, 1, 'consent', 10)).toBe('rejected')
    // Consent is objection-driven (sociocratic no-objection): zero recorded
    // support with zero objections still adopts — abstention never blocks.
    expect(computeResult(0, 0, 'consent', 10)).toBe('passed')
  })

  it('support_threshold: passed iff yes reaches the declared fraction of ALL eligible members', () => {
    expect(computeResult(5, 15, 'support_threshold', 20, 0.25)).toBe('passed') // exactly at threshold
    expect(computeResult(4, 0, 'support_threshold', 20, 0.25)).toBe('rejected')
    // 0.1 * 30 is 3.0000000000000004 in binary floating point — the rule's
    // epsilon keeps 3 supporters of 30 at a 10% quorum PASSING.
    expect(computeResult(3, 27, 'support_threshold', 30, 0.1)).toBe('passed')
    // Nein votes never count against a support quorum — only supporters matter.
    expect(computeResult(5, 15, 'support_threshold', 20, 0.25)).toBe(
      computeResult(5, 0, 'support_threshold', 20, 0.25),
    )
    // No declared fraction → no computable verdict (the display stays empty
    // until the rule is fully declared; the server validates at write time).
    expect(computeResult(5, 0, 'support_threshold', 20)).toBeNull()
  })

  it('support_threshold: IEEE-754 noise does NOT wrongly reject an exactly-at-quorum tally', () => {
    // 0.55 * 100 === 55.00000000000001 — a bare Math.ceil would push the
    // threshold to 56 and reject a genuinely-passing 55-of-100 vote. This is the
    // exact tuple where the pre-fix client (no ceil) and server (bare ceil) also
    // diverged; both now share supportThreshold() so 55 PASSES on both sides.
    expect(computeResult(55, 45, 'support_threshold', 100, 0.55)).toBe('passed')
    expect(computeResult(54, 46, 'support_threshold', 100, 0.55)).toBe('rejected')
    // 0.07 * 100 === 7.000000000000001 — same noise class; threshold 7.
    expect(computeResult(7, 93, 'support_threshold', 100, 0.07)).toBe('passed')
    expect(computeResult(6, 94, 'support_threshold', 100, 0.07)).toBe('rejected')
    // A TRUE fractional boundary is unaffected: 0.25 * 10 = 2.5 → ceil 3.
    expect(computeResult(3, 7, 'support_threshold', 10, 0.25)).toBe('passed')
    expect(computeResult(2, 8, 'support_threshold', 10, 0.25)).toBe('rejected')
  })

  it('support_threshold: fails CLOSED on an out-of-(0,1] fraction (mirrors the server throw)', () => {
    // The server rule throws InvalidDecisionRuleParamsError for these; the
    // display mirror has no verdict to show (null), never an accidental verdict.
    expect(computeResult(5, 0, 'support_threshold', 20, 0)).toBeNull() // <= 0
    expect(computeResult(5, 0, 'support_threshold', 20, -0.25)).toBeNull() // <= 0
    expect(computeResult(5, 0, 'support_threshold', 20, 1.5)).toBeNull() // > 1
    expect(computeResult(5, 0, 'support_threshold', 20, Number.NaN)).toBeNull() // NaN
  })

  it('unknown rule id: no preview (null), never an accidental verdict', () => {
    // Defensive default: a runtime value outside the typed union (e.g. a
    // module-registered rule the mirror does not know) yields null, not 'rejected'.
    expect(computeResult(5, 0, 'unanimity_plus' as unknown as 'simple', 10)).toBeNull()
  })

  it('null tallies (acclamation / no-tally rows): NO computed verdict', () => {
    expect(computeResult(null, null, 'simple', 10)).toBeNull()
    expect(computeResult(null, 3, 'two_thirds', 10)).toBeNull()
    expect(computeResult(4, null, 'consent', 10)).toBeNull()
  })
})
