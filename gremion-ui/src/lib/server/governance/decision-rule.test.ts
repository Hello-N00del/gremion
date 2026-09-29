import { describe, it, expect } from 'vitest'
import { evaluateMajority, type MajorityRule } from './decision-rule'
import { beforeEach } from 'vitest'
import {
  evaluateDecisionRule,
  InvalidDecisionRuleParamsError,
  InvalidDecisionRuleTallyError,
  UnknownDecisionRuleError,
} from './decision-rule'
import {
  registerDecisionRule,
  ReservedDecisionRuleIdError,
  _resetRuntimeRegistryForTests,
  type DecisionRuleContext,
} from '$lib/server/modules/runtime-registry'

describe('evaluateMajority', () => {
  it('simple: passes when yes > no, fails on a tie', () => {
    expect(evaluateMajority(2, 1, 'simple', 10)).toBe(true)
    expect(evaluateMajority(2, 2, 'simple', 10)).toBe(false)
    expect(evaluateMajority(0, 0, 'simple', 10)).toBe(false)
  })

  it('two_thirds: passes at exactly 2/3 of cast (yes >= 2*no)', () => {
    expect(evaluateMajority(2, 1, 'two_thirds', 10)).toBe(true) // 2 of 3 cast
    expect(evaluateMajority(3, 2, 'two_thirds', 10)).toBe(false) // 3 of 5 = 0.6
    expect(evaluateMajority(4, 2, 'two_thirds', 10)).toBe(true)
  })

  it('absolute: passes only with more than half of ALL eligible members', () => {
    expect(evaluateMajority(6, 0, 'absolute', 10)).toBe(true)
    expect(evaluateMajority(5, 0, 'absolute', 10)).toBe(false) // exactly half is not enough
    expect(evaluateMajority(5, 4, 'absolute', 9)).toBe(true)
  })
})

// ── T2: strategy registry + registerDecisionRule() extension seam ───────────
/** Full-shape ctx builder so every strategy call site carries all six keys. */
const ctx = (over: Partial<DecisionRuleContext> = {}): DecisionRuleContext => ({
  yes: 0,
  no: 0,
  abstain: 0,
  eligible: 0,
  present: 0,
  params: null,
  ...over,
})

describe('evaluateDecisionRule (strategy registry)', () => {
  beforeEach(() => {
    _resetRuntimeRegistryForTests()
  })

  it('consent: passes iff no === 0 — zero votes cast still passes', () => {
    expect(evaluateDecisionRule('consent', ctx({ yes: 3, no: 0, abstain: 2, eligible: 10, present: 5 }))).toBe(true)
    // cast may be 0: nobody voted yes or no, only abstentions
    expect(evaluateDecisionRule('consent', ctx({ yes: 0, no: 0, abstain: 4, eligible: 10, present: 4 }))).toBe(true)
    // any single objection rejects, regardless of the yes count
    expect(evaluateDecisionRule('consent', ctx({ yes: 9, no: 1, abstain: 0, eligible: 10, present: 10 }))).toBe(false)
    expect(evaluateDecisionRule('consent', ctx({ yes: 0, no: 1, abstain: 0, eligible: 10, present: 1 }))).toBe(false)
  })

  it('support_threshold: passes iff yes >= ceil(fraction * eligible)', () => {
    // fraction 0.75 of 8 eligible → threshold exactly 6
    expect(evaluateDecisionRule('support_threshold', ctx({ yes: 6, eligible: 8, params: { fraction: 0.75 } }))).toBe(true) // exact ceil
    expect(evaluateDecisionRule('support_threshold', ctx({ yes: 5, eligible: 8, params: { fraction: 0.75 } }))).toBe(false) // ceil - 1
    // fraction 0.5 of 7 eligible → ceil(3.5) = 4
    expect(evaluateDecisionRule('support_threshold', ctx({ yes: 4, eligible: 7, params: { fraction: 0.5 } }))).toBe(true) // exact ceil
    expect(evaluateDecisionRule('support_threshold', ctx({ yes: 3, eligible: 7, params: { fraction: 0.5 } }))).toBe(false) // ceil - 1
    // fraction 1 is a valid upper bound: unanimity of the eligible
    expect(evaluateDecisionRule('support_threshold', ctx({ yes: 7, eligible: 7, params: { fraction: 1 } }))).toBe(true)
  })

  it('support_threshold: IEEE-754 noise does NOT wrongly reject an exactly-at-quorum tally', () => {
    // 0.55 * 100 === 55.00000000000001 in double precision; a bare
    // Math.ceil(fraction*eligible) would round the threshold up to 56 and
    // WRONGLY reject a genuinely-passing 55-of-100 vote. Epsilon-before-ceil
    // keeps the real threshold at 55.
    expect(evaluateDecisionRule('support_threshold', ctx({ yes: 55, eligible: 100, params: { fraction: 0.55 } }))).toBe(true)
    expect(evaluateDecisionRule('support_threshold', ctx({ yes: 54, eligible: 100, params: { fraction: 0.55 } }))).toBe(false)
    // 0.07 * 100 === 7.000000000000001 — same class of noise; threshold is 7.
    expect(evaluateDecisionRule('support_threshold', ctx({ yes: 7, eligible: 100, params: { fraction: 0.07 } }))).toBe(true)
    expect(evaluateDecisionRule('support_threshold', ctx({ yes: 6, eligible: 100, params: { fraction: 0.07 } }))).toBe(false)
    // A TRUE fractional boundary is unaffected: 0.25 * 10 = 2.5 → ceil 3.
    expect(evaluateDecisionRule('support_threshold', ctx({ yes: 3, eligible: 10, params: { fraction: 0.25 } }))).toBe(true)
    expect(evaluateDecisionRule('support_threshold', ctx({ yes: 2, eligible: 10, params: { fraction: 0.25 } }))).toBe(false)
  })

  it('support_threshold: throws a typed error on missing/invalid fraction — never a default', () => {
    const invalidParams: (Record<string, unknown> | null)[] = [
      null, // decision_rule_params absent entirely
      {}, // fraction missing
      { fraction: '0.5' }, // non-numeric
      { fraction: Number.NaN }, // non-numeric (NaN)
      { fraction: 0 }, // <= 0
      { fraction: -0.25 }, // <= 0
      { fraction: 1.5 }, // > 1
    ]
    for (const params of invalidParams) {
      // yes === eligible would pass under ANY defaulted fraction — the throw
      // proves no default was silently applied.
      expect(() => evaluateDecisionRule('support_threshold', ctx({ yes: 10, eligible: 10, params }))).toThrow(
        InvalidDecisionRuleParamsError,
      )
    }
  })

  it('unknown rule id: throws a typed error, never falls back to simple', () => {
    // yes=5 no=0 would PASS under 'simple' — the throw proves there is no fallback.
    expect(() => evaluateDecisionRule('unanimity_plus', ctx({ yes: 5, no: 0, eligible: 5, present: 5 }))).toThrow(
      UnknownDecisionRuleError,
    )
  })

  it('a strategy added via registerDecisionRule() is resolvable and receives the full ctx', () => {
    const seen: DecisionRuleContext[] = []
    registerDecisionRule('module:presence_quorum', (c) => {
      seen.push(c)
      return c.present * 2 > c.eligible && c.yes > c.no
    })
    const input = ctx({ yes: 4, no: 2, abstain: 1, eligible: 12, present: 7, params: { note: 'x' } })
    expect(evaluateDecisionRule('module:presence_quorum', input)).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ yes: 4, no: 2, abstain: 1, eligible: 12, present: 7, params: { note: 'x' } })
  })

  it('refuses to register over a core rule id', () => {
    for (const coreId of ['simple', 'two_thirds', 'absolute', 'consent', 'support_threshold']) {
      expect(() => registerDecisionRule(coreId, () => true)).toThrow(ReservedDecisionRuleIdError)
    }
    // and the shipped core semantics stay intact after the refused attempts
    expect(evaluateDecisionRule('simple', ctx({ yes: 1, no: 1, eligible: 10, present: 2 }))).toBe(false)
    expect(evaluateDecisionRule('simple', ctx({ yes: 2, no: 1, eligible: 10, present: 3 }))).toBe(true)
  })
})

// TASK-206-0 review: no rule adopts on zero support, and a malformed tally is
// refused (typed) before any strategy, core or module, sees it.
describe('evaluateDecisionRule: fail-closed tallies (TASK-206-0 review)', () => {
  beforeEach(() => {
    _resetRuntimeRegistryForTests()
  })

  it('support_threshold never adopts with zero yes votes (empty body, tiny fraction)', () => {
    expect(evaluateDecisionRule('support_threshold', ctx({ yes: 0, eligible: 0, params: { fraction: 0.5 } }))).toBe(false)
    expect(evaluateDecisionRule('support_threshold', ctx({ yes: 0, eligible: 100, params: { fraction: 1e-12 } }))).toBe(false)
    expect(evaluateDecisionRule('support_threshold', ctx({ yes: 1, eligible: 100, params: { fraction: 1e-12 } }))).toBe(true)
  })

  it.each([
    ['negative eligible', { yes: 0, eligible: -1 }],
    ['negative no', { yes: 0, no: -1 }],
    ['infinite yes', { yes: Infinity }],
    ['NaN present', { present: Number.NaN }],
    ['fractional abstain', { abstain: 0.5 }],
  ] as const)('refuses a malformed tally (%s) with a typed error', (_n, over) => {
    expect(() => evaluateDecisionRule('simple', ctx(over))).toThrow(InvalidDecisionRuleTallyError)
    expect(() => evaluateDecisionRule('absolute', ctx(over))).toThrow(InvalidDecisionRuleTallyError)
  })

  it('a module strategy never sees a malformed tally', () => {
    let seen = 0
    registerDecisionRule('module_rule', () => {
      seen += 1
      return true
    })
    expect(() => evaluateDecisionRule('module_rule', ctx({ eligible: -3 }))).toThrow(InvalidDecisionRuleTallyError)
    expect(seen).toBe(0)
  })
})

// TASK-206-0 review: the kernel routes hand evaluateMajority an unvalidated
// body.requiredMajority. Until item 1a threads consent/support_threshold (and
// their params) through adoption, the wrapper keeps its pre-port verdict for
// anything outside the three majority rules: not passed, never a 500.
describe('evaluateMajority keeps the pre-port verdict outside the majority rules', () => {
  it.each(['consent', 'support_threshold', 'bogus'])('%s -> false', (rule) => {
    expect(evaluateMajority(3, 0, rule as MajorityRule, 5)).toBe(false)
  })
})
