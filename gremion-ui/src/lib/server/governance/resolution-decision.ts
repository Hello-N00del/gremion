import type { PgTransaction } from '$lib/server/db/tx'
import { evaluateDecisionRule, type CoreDecisionRuleId } from './decision-rule'
import { getQuorumContext, type QuorumContext } from './quorum'

export class NotQuorateError extends Error {
  readonly eligibleVotingCount: number
  readonly presentVotingCount: number
  constructor(ctx: QuorumContext) {
    super(`Nicht beschlussfähig: ${ctx.presentVotingCount}/${ctx.eligibleVotingCount} stimmberechtigte Mitglieder anwesend`)
    this.name = 'NotQuorateError'
    this.eligibleVotingCount = ctx.eligibleVotingCount
    this.presentVotingCount = ctx.presentVotingCount
  }
}

/**
 * INV-5 for the acclamation franchise: the chair's declared outcome is an
 * enumerated act ('passed' | 'rejected'), never free text. 'withdrawn' is NOT a
 * declarable outcome — withdrawal is a separate author act (the `withdrawn`
 * flag), so it is rejected here too.
 */
export class InvalidDeclaredResultError extends Error {
  readonly declaredResult: unknown
  constructor(declaredResult: unknown) {
    super(`Ungültiges Akklamations-Ergebnis: ${JSON.stringify(declaredResult)} — erlaubt sind 'passed' | 'rejected'`)
    this.name = 'InvalidDeclaredResultError'
    this.declaredResult = declaredResult
  }
}

/** Majority rules known to the adoption engine: the kernel's core decision-rule
 * vocabulary. Rule EVALUATION is NOT re-implemented here — it is delegated to the
 * single source of truth, the canonical registry in `decision-rule.ts`. There is
 * therefore no rule math (and no duplicate registry) in this module. */
export type AdoptionMajorityRule = CoreDecisionRuleId

/** Declared parameters of a parametrised rule, threaded verbatim to the canonical
 * registry as the strategy's `params`. */
export type MajorityRuleParams = {
  /** support_threshold: yes must reach ceil(fraction × ELIGIBLE), fraction in (0, 1].
   *  The registry (decision-rule.ts) owns this math and fails closed on a
   *  missing/invalid fraction — this module never re-derives it. */
  fraction?: number
}

interface ResolutionDecisionBase {
  protocolId: string
  withdrawn?: boolean
  /**
   * INV-5 enforces quorum AT ADOPTION, not during draft data-entry. The
   * resolution-write endpoints (draft) pass `false` to compute the result from
   * the rule+tallies without blocking; the adoption point (protocol publish)
   * enforces quorum hard. Defaults to `true`, so the service is fail-safe for any
   * caller that means "adopt this now".
   */
  enforceQuorum?: boolean
}

/** Default mode: the result is computed from the pre-declared rule + tallies. */
export interface TallyDecisionInput extends ResolutionDecisionBase {
  adoptionMode?: 'tally'
  votesYes: number
  votesNo: number
  votesAbstain: number
  requiredMajority: AdoptionMajorityRule
  params?: MajorityRuleParams
}

/**
 * Acclamation franchise (charter Phase-2 item 4): collective attribution with no
 * tally — the chair declares the outcome ('passed' | 'rejected'), which is
 * validated, never accepted free-hand. Tally inputs are not consulted.
 */
export interface AcclamationDecisionInput extends ResolutionDecisionBase {
  adoptionMode: 'acclamation'
  declaredResult?: string
  votesYes?: number | null
  votesNo?: number | null
  votesAbstain?: number | null
}

export type ResolutionDecisionInput = TallyDecisionInput | AcclamationDecisionInput

/**
 * Governance Core INV-5: the authoritative `result` is computed here —
 * never accepted free-hand. Tally mode evaluates the pre-declared rule + tallies
 * by DELEGATING to the canonical decision-rule registry (decision-rule.ts, the
 * single source of truth for rule semantics); acclamation mode validates the
 * declared outcome against the enumerated set and skips rule evaluation entirely.
 * The quorum context is always loaded (the `absolute` rule needs the
 * eligible-voter count) and gates BOTH modes identically; whether a non-quorate
 * meeting throws is governed by `enforceQuorum` (default true). `withdrawn` is
 * an explicit author act and bypasses both gates.
 */
export async function decideResolution(
  input: ResolutionDecisionInput,
  tx?: PgTransaction,
): Promise<{ result: 'passed' | 'rejected' | 'withdrawn'; quorum: QuorumContext | null }> {
  if (input.withdrawn) {
    return { result: 'withdrawn', quorum: null }
  }
  const quorum = await getQuorumContext(input.protocolId, tx)
  if ((input.enforceQuorum ?? true) && !quorum.quorate) {
    throw new NotQuorateError(quorum)
  }
  if (input.adoptionMode === 'acclamation') {
    const declared = input.declaredResult
    if (declared !== 'passed' && declared !== 'rejected') {
      throw new InvalidDeclaredResultError(declared)
    }
    return { result: declared, quorum }
  }
  // INV-5: rule evaluation is delegated to the single source of truth — the
  // canonical decision-rule registry (decision-rule.ts). No rule math lives here.
  // An unknown/misdeclared rule id and a missing/invalid support_threshold
  // fraction both fail CLOSED there (Unknown/InvalidDecisionRuleParamsError),
  // never silently degrading to a simple majority. support_threshold is judged
  // against fraction-of-ELIGIBLE (ceil), in step with decision-rule.ts and the
  // compute-result.ts client mirror.
  const passed = evaluateDecisionRule(input.requiredMajority, {
    yes: input.votesYes,
    no: input.votesNo,
    abstain: input.votesAbstain,
    eligible: quorum.eligibleVotingCount,
    present: quorum.presentVotingCount,
    params: input.params ?? null,
  })
  return { result: passed ? 'passed' : 'rejected', quorum }
}
