// Governance Core INV-5 — DISPLAY-ONLY client mirror of the server's
// authoritative rule (`evaluateMajority` in $lib/server/governance/decision-rule.ts,
// which lives under $lib/server and therefore cannot be imported into a client
// component). ResolutionRow uses this to render the same 'berechnet' verdict the
// server will persist, without a round-trip. It is NEVER the authority: the
// resolution-write endpoints recompute server-side on every write and the client
// never sends a free-hand `result`. This MUST stay byte-for-byte in step with
// evaluateMajority — same branches, same `&& yes+no>0` guard on two_thirds — so
// the preview can never disagree with the stored value.
export type MajorityRule = 'simple' | 'two_thirds' | 'absolute'

/**
 * Display verdict for a tally under `rule`. Abstentions never count toward a
 * majority; `eligible` (the count of eligible voting members) is only consulted
 * by the `absolute` rule. Returns the same pass/fail decision as the server's
 * evaluateMajority, expressed as the resolution's stored result string.
 */
export function computeResult(
  yes: number,
  no: number,
  rule: MajorityRule,
  eligible: number,
): 'passed' | 'rejected' {
  let passed: boolean
  switch (rule) {
    case 'simple':
      passed = yes > no
      break
    case 'two_thirds':
      // yes >= 2/3 of (yes+no)  <=>  3*yes >= 2*(yes+no)  <=>  yes >= 2*no
      passed = yes >= 2 * no && yes + no > 0
      break
    case 'absolute':
      // strictly more than half of ALL eligible voting members
      passed = yes * 2 > eligible
      break
  }
  return passed ? 'passed' : 'rejected'
}
