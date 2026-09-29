// Governance Core INV-5 — DISPLAY-ONLY client mirror of the server's
// authoritative rule (`evaluateMajority` in $lib/server/governance/decision-rule.ts,
// which lives under $lib/server and therefore cannot be imported into a client
// component). ResolutionRow uses this to render the same 'berechnet' verdict the
// server will persist, without a round-trip. It is NEVER the authority: the
// resolution-write endpoints recompute server-side on every write and the client
// never sends a free-hand `result`. This MUST stay byte-for-byte in step with
// evaluateMajority — same branches, same `&& yes+no>0` guard on two_thirds, and
// the same Phase-2 registry semantics (charter §8 item 5) for consent and
// support_threshold — so the preview can never disagree with the stored value.
// The support_threshold math is NOT re-implemented here: both this mirror and the
// server rule call the SAME shared `supportThreshold()` helper (which owns the
// epsilon-before-ceil), so the two derive an identical integer threshold.
import { supportThreshold } from './support-threshold'

export type MajorityRule =
  | 'simple'
  | 'two_thirds'
  | 'absolute'
  // Phase-2 decision-rule registry (charter §8 item 5):
  | 'consent'
  | 'support_threshold'

/**
 * Display verdict for a tally under `rule`. Abstentions never count toward a
 * majority; `eligible` (the count of eligible voting members) is only consulted
 * by the `absolute` and `support_threshold` rules. Returns the same pass/fail
 * decision as the server's rule, expressed as the resolution's stored result
 * string — or `null` when no verdict is computable:
 *   • a null tally (acclamation / show-of-hands rows carry NO per-voter tally —
 *     the outcome is DECLARED, never computed), or
 *   • `support_threshold` without its declared fraction (the rule is not fully
 *     declared yet; the server validates the fraction at write time).
 */
export function computeResult(
  yes: number | null,
  no: number | null,
  rule: MajorityRule,
  eligible: number,
  supportFraction?: number | null,
): 'passed' | 'rejected' | null {
  // `== null` on purpose: a cleared numeric input binds to undefined at runtime.
  if (yes == null || no == null) return null
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
    case 'consent':
      // sociocratic no-objection: a single Nein blocks; silence/abstention adopts
      passed = no === 0
      break
    case 'support_threshold':
      // yes must reach the declared fraction of ALL eligible members; Nein votes
      // never count against a support quorum. Fail CLOSED like the server rule:
      // an undeclared or out-of-(0,1] fraction yields NO verdict (the server
      // throws InvalidDecisionRuleParamsError at write time). The integer
      // threshold comes from the SHARED helper the server rule also uses.
      if (typeof supportFraction !== 'number' || !(supportFraction > 0) || supportFraction > 1) return null
      passed = yes >= supportThreshold(supportFraction, eligible)
      break
    default:
      // Unknown rule → no preview (never an accidental 'rejected'). The server
      // registry fails closed on an unknown id (UnknownDecisionRuleError).
      return null
  }
  return passed ? 'passed' : 'rejected'
}
