// Governance Core INV-5 — the ONE support-threshold quorum contract,
// shared by the authoritative server rule (`$lib/server/governance/decision-rule.ts`)
// and its DISPLAY-ONLY client mirror (`./compute-result.ts`) so the two can never
// disagree. This module is client-safe (no `$lib/server` imports), so the server
// rule imports it too — a single source of truth for the threshold math.
//
// A support_threshold passes iff `yes` reaches ceil(fraction × eligible). The
// multiplication happens in IEEE-754 double precision, where e.g.
//   0.55 × 100 === 55.00000000000001   and   0.07 × 100 === 7.000000000000001
// so a bare `Math.ceil(fraction × eligible)` rounds a genuinely-passing 55-of-100
// (0.55) vote UP to a threshold of 56 and WRONGLY rejects it. Subtracting a tiny
// epsilon BEFORE the ceil absorbs that float noise without moving any true
// fractional boundary (0.25 × 10 = 2.5 still ceils to 3; 0.5 × 7 = 3.5 → 4).
export const FRACTION_EPSILON = 1e-9

/**
 * The minimum `yes` count that adopts under `fraction` of `eligible` — the
 * integer support threshold. Epsilon-before-ceil (see {@link FRACTION_EPSILON}).
 * Both the server rule and the client mirror MUST derive their verdict from THIS
 * function, so the preview can never disagree with the persisted result.
 *
 * Never below 1 (TASK-206-0): an empty body (`eligible === 0`) or a fraction so
 * small that `fraction × eligible` vanishes must not adopt on zero support.
 */
export function supportThreshold(fraction: number, eligible: number): number {
  return Math.max(1, Math.ceil(fraction * eligible - FRACTION_EPSILON))
}
