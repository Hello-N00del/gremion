// Civitas Governance charter Slot B — the second locus (resource-commitment
// guard): no actor unilaterally commits collective resources as sole decider.
// HOW the second locus is staged (ex-ante co-signature à la Vier-Augen, M-of-N,
// review-window, …) is a pluggable SecondLocusStrategy resolved BY ID from the
// runtime registry, mirroring the decision-rule seam (decision-rule.ts): core
// strategies first, then module-contributed ones (registerSecondLocusStrategy()
// in $lib/server/modules/runtime-registry.ts). Resolution is FAIL-CLOSED — an
// unknown id throws UnknownSecondLocusStrategyError; it NEVER falls back to a
// permissive no-guard result.
//
// Unlike the decision-rule seam, the kernel reserves NO placeholder ids for
// this seam: verticals OWN their strategy ids (finance ships 'vier-augen' from
// $lib/server/finance/services/write/vier-augen-strategy.ts). The kernel ships
// no core strategy yet — _coreStrategies stays empty — so every live id today
// is module-contributed.
import {
  getModuleSecondLocusStrategy,
  type SecondLocusStrategy,
} from '$lib/server/modules/runtime-registry'

export type {
  SecondLocusStrategy,
  SecondLocusSignerStageDef,
  SecondLocusAuthorityTier,
  SecondLocusStageInput,
  SecondLocusBuiltStage,
  SecondLocusActor,
  SecondLocusApprovalMeta,
  SecondLocusStageState,
  SecondLocusDistinctnessResult,
} from '$lib/server/modules/runtime-registry'

/** Thrown when a strategy id is neither core nor module-registered. Fail-
 *  closed: the caller must refuse the commitment action, never degrade to a
 *  permissive no-guard default. */
export class UnknownSecondLocusStrategyError extends Error {
  readonly strategyId: string
  constructor(strategyId: string) {
    super(
      `unknown second-locus strategy '${strategyId}' — refusing to resolve (no permissive fallback)`,
    )
    this.name = 'UnknownSecondLocusStrategyError'
    this.strategyId = strategyId
  }
}

// The kernel ships NO core strategy yet. An empty Map keeps resolution
// structurally identical to decision-rule.ts (and safe from Object.prototype
// hits once core strategies exist).
const _coreStrategies = new Map<string, SecondLocusStrategy>()

/**
 * Resolve `strategyId` to its strategy: core strategies first, then module-
 * registered ones. FAIL-CLOSED: an unknown id throws
 * UnknownSecondLocusStrategyError — a misdeclared or since-removed strategy
 * must surface as an error at resolution, never silently wave a resource
 * commitment through.
 */
export function resolveSecondLocusStrategy(strategyId: string): SecondLocusStrategy {
  const strategy = _coreStrategies.get(strategyId) ?? getModuleSecondLocusStrategy(strategyId)
  if (!strategy) throw new UnknownSecondLocusStrategyError(strategyId)
  return strategy
}
