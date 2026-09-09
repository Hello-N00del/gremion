// Governance Core INV-5: the decision rule for a resolution's class is
// declared before the act and evaluated at adoption — never an individual's free hand.
export type MajorityRule = 'simple' | 'two_thirds' | 'absolute'

export const DEFAULT_MAJORITY: MajorityRule = 'simple'

/**
 * Returns true iff the tally satisfies `rule`. Abstentions never count toward
 * a majority. `eligibleVotingCount` is only consulted by the `absolute` rule.
 */
export function evaluateMajority(
  votesYes: number,
  votesNo: number,
  rule: MajorityRule,
  eligibleVotingCount: number,
): boolean {
  switch (rule) {
    case 'simple':
      return votesYes > votesNo
    case 'two_thirds':
      // yes >= 2/3 of (yes+no)  <=>  3*yes >= 2*(yes+no)  <=>  yes >= 2*no
      return votesYes >= 2 * votesNo && votesYes + votesNo > 0
    case 'absolute':
      // strictly more than half of ALL eligible voting members
      return votesYes * 2 > eligibleVotingCount
  }
}
