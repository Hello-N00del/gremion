import type { PgTransaction } from '$lib/server/db/tx'
import { evaluateMajority, type MajorityRule } from './decision-rule'
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

export interface ResolutionDecisionInput {
  protocolId: string
  votesYes: number
  votesNo: number
  votesAbstain: number
  requiredMajority: MajorityRule
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

/**
 * Governance Core INV-5: the authoritative `result` is computed here from
 * the pre-declared rule + tallies — never accepted free-hand. The quorum context
 * is always loaded (the `absolute` rule needs the eligible-voter count); whether
 * a non-quorate meeting throws is governed by `enforceQuorum` (default true).
 * `withdrawn` is an explicit author act and bypasses both gates.
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
  const passed = evaluateMajority(input.votesYes, input.votesNo, input.requiredMajority, quorum.eligibleVotingCount)
  return { result: passed ? 'passed' : 'rejected', quorum }
}
