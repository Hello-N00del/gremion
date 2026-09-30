// Governance Core INV-5: the decision rule for a resolution's class is
// declared before the act and evaluated at adoption — never an individual's
// free hand. Rules resolve BY ID from a strategy registry: the five core
// strategies below plus module-contributed ones (registerDecisionRule() in
// $lib/server/modules/runtime-registry.ts). Resolution is FAIL-CLOSED — an
// unknown id throws UnknownDecisionRuleError; it NEVER falls back to 'simple'.
import {
  CORE_DECISION_RULE_IDS,
  getModuleDecisionRule,
  type DecisionRuleContext,
  type DecisionRuleStrategy,
} from '$lib/server/modules/runtime-registry'
// Shared, client-safe threshold math — the SAME helper the display mirror
// (`$lib/governance/compute-result.ts`) uses, so server verdict and client
// preview can never diverge. Epsilon-before-ceil lives there (FRACTION_EPSILON).
import { supportThreshold } from '$lib/governance/support-threshold'

export type { DecisionRuleContext, DecisionRuleStrategy }
export { CORE_DECISION_RULE_IDS }

/** A kernel-shipped rule id (the reserved core vocabulary). */
export type CoreDecisionRuleId = (typeof CORE_DECISION_RULE_IDS)[number]

/** The three original majority rules (what resolutions persist today). Kept as
 *  its own narrow union so existing callers/columns stay typed exactly as
 *  before the registry refactor. */
export type MajorityRule = 'simple' | 'two_thirds' | 'absolute'

export const DEFAULT_MAJORITY: MajorityRule = 'simple'

const MAJORITY_RULES: readonly MajorityRule[] = ['simple', 'two_thirds', 'absolute']

/** Thrown when a rule id is neither core nor module-registered. Fail-closed:
 *  the caller must treat the resolution as UNDECIDABLE, never as 'simple'. */
export class UnknownDecisionRuleError extends Error {
  readonly ruleId: string
  constructor(ruleId: string) {
    super(`unknown decision rule '${ruleId}' — refusing to evaluate (no fallback to 'simple')`)
    this.name = 'UnknownDecisionRuleError'
    this.ruleId = ruleId
  }
}

/** Thrown when a rule's declared decision_rule_params are missing or invalid
 *  for the rule being evaluated (no silent defaulting). */
export class InvalidDecisionRuleParamsError extends Error {
  readonly ruleId: string
  constructor(ruleId: string, detail: string) {
    super(`invalid decision_rule_params for rule '${ruleId}': ${detail}`)
    this.name = 'InvalidDecisionRuleParamsError'
    this.ruleId = ruleId
  }
}

/** Thrown when a tally count is not a finite non-negative integer (TASK-206-0).
 *  Fail-closed: no strategy, core or module, ever judges such a tally. */
export class InvalidDecisionRuleTallyError extends Error {
  readonly ruleId: string
  constructor(ruleId: string, detail: string) {
    super(`invalid tally for rule '${ruleId}': ${detail}`)
    this.name = 'InvalidDecisionRuleTallyError'
    this.ruleId = ruleId
  }
}

const TALLY_KEYS = ['yes', 'no', 'abstain', 'eligible', 'present'] as const

function assertValidTally(ruleId: string, ctx: DecisionRuleContext): void {
  for (const key of TALLY_KEYS) {
    const v = ctx[key]
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new InvalidDecisionRuleTallyError(ruleId, `'${key}' must be a non-negative integer, got ${String(v)}`)
    }
  }
}

// The five kernel-shipped strategies. Abstentions never count toward a
// majority; `eligible` is consulted only by absolute + support_threshold.
const CORE_STRATEGIES: Record<CoreDecisionRuleId, DecisionRuleStrategy> = {
  // yes strictly outnumbers no (ties fail).
  simple: ({ yes, no }) => yes > no,
  // yes >= 2/3 of (yes+no)  <=>  3*yes >= 2*(yes+no)  <=>  yes >= 2*no
  two_thirds: ({ yes, no }) => yes >= 2 * no && yes + no > 0,
  // strictly more than half of ALL eligible voting members
  absolute: ({ yes, eligible }) => yes * 2 > eligible,
  // passes iff nobody objects — zero votes cast (abstentions only) still passes
  consent: ({ no }) => no === 0,
  // yes >= supportThreshold(fraction, eligible) = ceil(fraction*eligible - ε);
  // `fraction` MUST be declared in params, a number in (0, 1] — anything else
  // throws (typed), never defaults. The epsilon-before-ceil (shared helper) keeps
  // a genuinely-passing at-quorum tally (e.g. 55 yes of 100 at 0.55, where
  // 0.55*100 === 55.00000000000001 in IEEE-754) from being wrongly rejected.
  support_threshold: ({ yes, eligible, params }) => {
    const fraction = params?.['fraction']
    if (typeof fraction !== 'number' || Number.isNaN(fraction) || fraction <= 0 || fraction > 1) {
      throw new InvalidDecisionRuleParamsError(
        'support_threshold',
        `'fraction' must be a number in (0, 1], got ${JSON.stringify(fraction) ?? String(fraction)}`,
      )
    }
    return yes >= supportThreshold(fraction, eligible)
  },
}

// A Map so lookup by arbitrary string id cannot hit Object.prototype members.
const _coreStrategies = new Map<string, DecisionRuleStrategy>(Object.entries(CORE_STRATEGIES))

/**
 * Resolve `ruleId` to its strategy: core rules first, then module-registered
 * ones. FAIL-CLOSED: an unknown id throws UnknownDecisionRuleError — a
 * misdeclared or since-removed rule must surface as an error at evaluation,
 * never silently degrade to a simple majority.
 */
export function resolveDecisionRule(ruleId: string): DecisionRuleStrategy {
  const strategy = _coreStrategies.get(ruleId) ?? getModuleDecisionRule(ruleId)
  if (!strategy) throw new UnknownDecisionRuleError(ruleId)
  return strategy
}

/** Resolve `ruleId` and evaluate its strategy against the tally `ctx`. */
export function evaluateDecisionRule(ruleId: string, ctx: DecisionRuleContext): boolean {
  const strategy = resolveDecisionRule(ruleId)
  assertValidTally(ruleId, ctx)
  return strategy(ctx)
}

/**
 * Returns true iff the tally satisfies `rule`. Abstentions never count toward
 * a majority. `eligibleVotingCount` is only consulted by the `absolute` rule.
 * (Compatibility wrapper over the registry for the original three rules; the
 * shipped semantics are pinned by the original decision-rule tests.)
 */
export function evaluateMajority(
  votesYes: number,
  votesNo: number,
  rule: MajorityRule,
  eligibleVotingCount: number,
): boolean {
  // TASK-206-0: callers pass an unvalidated stored/body rule. Outside the three
  // majority rules the pre-port verdict (not passed) holds until item 1a
  // threads consent/support_threshold and their params through adoption.
  if (!(MAJORITY_RULES as readonly string[]).includes(rule)) return false
  return evaluateDecisionRule(rule, {
    yes: votesYes,
    no: votesNo,
    abstain: 0,
    eligible: eligibleVotingCount,
    present: votesYes + votesNo,
    params: null,
  })
}
