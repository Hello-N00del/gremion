// src/lib/server/governance/second-locus.test.ts
// Governance charter Slot B — the second-locus seam. Mirrors the decision-rule
// strategy-registry tests: a module registers a SecondLocusStrategy by id via
// registerSecondLocusStrategy(); the kernel resolves it fail-closed in
// second-locus.ts. The contract shapes are derived from the finance Vier-Augen
// workflow's actual usage (approval-stages.ts buildStages/resolveTier +
// approval-workflow.ts #assertSignerEligible) but are KERNEL-OWNED — nothing
// here imports $lib/server/finance. The kernel reserves NO ids for this seam
// (verticals own their strategy ids), so registration is unconditional.
import { describe, it, expect, beforeEach } from 'vitest'
import { resolveSecondLocusStrategy, UnknownSecondLocusStrategyError } from './second-locus'
import {
  registerSecondLocusStrategy,
  _resetRuntimeRegistryForTests,
  type SecondLocusStrategy,
  type SecondLocusStageInput,
  type SecondLocusBuiltStage,
  type SecondLocusStageState,
  type SecondLocusActor,
  type SecondLocusApprovalMeta,
  type SecondLocusDistinctnessResult,
} from '$lib/server/modules/runtime-registry'

/** Full-shape staging input builder so every describeStages call site carries
 *  all three keys (signer config + authority tiers + amount snapshot). */
const stageInput = (over: Partial<SecondLocusStageInput> = {}): SecondLocusStageInput => ({
  signerStages: [
    { role: 'reviewer', required_group: 'group-review', certifies: ['substantive', 'arithmetical'] },
    { role: 'authoriser', required_group: 'group-authorise', certifies: ['ordering'] },
  ],
  decisionAuthorityTiers: [
    { max_amount_cents: 50_000, required_group: 'group-authorise' },
    { max_amount_cents: null, required_group: 'group-plenum' },
  ],
  amountCents: 12_300,
  ...over,
})

/** One persisted stage's signature state (identity + required group + signer). */
const stageState = (over: Partial<SecondLocusStageState> = {}): SecondLocusStageState => ({
  id: 1,
  requiredGroup: 'group-review',
  signerUserId: null,
  ...over,
})

/** A minimal inert strategy for registration-mechanics tests. */
const stubStrategy = (): SecondLocusStrategy => ({
  describeStages: () => [],
  validateDistinctness: () => ({ ok: true }),
})

/** Reference strategy expressing the finance workflow semantics over the
 *  KERNEL contract shapes: describeStages mirrors buildStages+resolveTier
 *  (the tier override targets the 'ordering' stage), validateDistinctness
 *  mirrors the three #assertSignerEligible guards IN ORDER (group
 *  eligibility → no-self-approval → distinct signers). Lives in the test
 *  only — the kernel ships no strategy yet. */
const fourEyesReference = (): SecondLocusStrategy => ({
  describeStages: ({ signerStages, decisionAuthorityTiers, amountCents }) => {
    const sorted = [...decisionAuthorityTiers].sort((a, b) => {
      if (a.max_amount_cents === null) return 1
      if (b.max_amount_cents === null) return -1
      return a.max_amount_cents - b.max_amount_cents
    })
    const tier =
      amountCents === null
        ? undefined
        : sorted.find((t) => t.max_amount_cents === null || amountCents <= t.max_amount_cents)
    return signerStages.map((d, i) => ({
      stageIndex: i,
      role: d.role,
      requiredGroup:
        tier !== undefined && d.certifies.includes('ordering') ? tier.required_group : d.required_group,
      certifies: d.certifies,
    }))
  },
  validateDistinctness: (stages, actor, approval, currentStage) => {
    if (!actor.groups.includes(currentStage.requiredGroup)) {
      return { ok: false, violation: 'group-ineligible' }
    }
    if (actor.userId === approval.createdBy) {
      return { ok: false, violation: 'self-approval' }
    }
    if (stages.some((s) => s.id !== currentStage.id && s.signerUserId === actor.userId)) {
      return { ok: false, violation: 'duplicate-signer' }
    }
    return { ok: true }
  },
})

describe('second-locus strategy registry', () => {
  beforeEach(() => {
    _resetRuntimeRegistryForTests()
  })

  it('a strategy added via registerSecondLocusStrategy() resolves by id and receives the exact input', () => {
    const describeSeen: SecondLocusStageInput[] = []
    const validateSeen: {
      stages: readonly SecondLocusStageState[]
      actor: SecondLocusActor
      approval: SecondLocusApprovalMeta
      currentStage: SecondLocusStageState
    }[] = []
    const built: SecondLocusBuiltStage[] = [
      { stageIndex: 0, role: 'reviewer', requiredGroup: 'group-review', certifies: ['substantive', 'arithmetical'] },
      { stageIndex: 1, role: 'authoriser', requiredGroup: 'group-authorise', certifies: ['ordering'] },
    ]
    registerSecondLocusStrategy('module:m_of_n', {
      describeStages: (input) => {
        describeSeen.push(input)
        return built
      },
      validateDistinctness: (stages, actor, approval, currentStage) => {
        validateSeen.push({ stages, actor, approval, currentStage })
        return { ok: false, violation: 'self-approval' }
      },
    })

    const strategy = resolveSecondLocusStrategy('module:m_of_n')

    const input = stageInput({ amountCents: 99_999 })
    expect(strategy.describeStages(input)).toEqual(built)
    expect(describeSeen).toHaveLength(1)
    // The EXACT input object is threaded through, not a copy or a projection.
    expect(describeSeen[0]).toBe(input)

    const stages = [stageState({ id: 11 }), stageState({ id: 12, requiredGroup: 'group-authorise' })]
    const actor: SecondLocusActor = { userId: 'u-creator', groups: ['group-review'] }
    const approval: SecondLocusApprovalMeta = { createdBy: 'u-creator' }
    const result = strategy.validateDistinctness(stages, actor, approval, stages[0])
    expect(result).toEqual({ ok: false, violation: 'self-approval' })
    expect(validateSeen).toHaveLength(1)
    expect(validateSeen[0].stages).toBe(stages)
    expect(validateSeen[0].actor).toBe(actor)
    expect(validateSeen[0].approval).toBe(approval)
    expect(validateSeen[0].currentStage).toBe(stages[0])
  })

  it('the distinctness verdict discriminates the three guards in #assertSignerEligible order', () => {
    registerSecondLocusStrategy('module:vier_augen_ref', fourEyesReference())
    const strategy = resolveSecondLocusStrategy('module:vier_augen_ref')
    const stages = [
      stageState({ id: 1, requiredGroup: 'group-review', signerUserId: 'u-first' }),
      stageState({ id: 2, requiredGroup: 'group-authorise' }),
    ]
    const current = stages[1]
    const approval: SecondLocusApprovalMeta = { createdBy: 'u-creator' }

    // An actor tripping ALL THREE guards fails on group eligibility FIRST.
    expect(
      strategy.validateDistinctness(stages, { userId: 'u-creator', groups: ['group-review'] }, approval, current),
    ).toEqual<SecondLocusDistinctnessResult>({ ok: false, violation: 'group-ineligible' })
    // Group-eligible creator (who also signed stage 1) fails on self-approval NEXT.
    expect(
      strategy.validateDistinctness(
        [stageState({ id: 1, signerUserId: 'u-creator' }), current],
        { userId: 'u-creator', groups: ['group-authorise'] },
        approval,
        current,
      ),
    ).toEqual<SecondLocusDistinctnessResult>({ ok: false, violation: 'self-approval' })
    // Group-eligible non-creator who already signed ANOTHER stage: duplicate-signer LAST.
    expect(
      strategy.validateDistinctness(stages, { userId: 'u-first', groups: ['group-authorise'] }, approval, current),
    ).toEqual<SecondLocusDistinctnessResult>({ ok: false, violation: 'duplicate-signer' })
    // A distinct, eligible, non-creator signer passes.
    expect(
      strategy.validateDistinctness(stages, { userId: 'u-second', groups: ['group-authorise'] }, approval, current),
    ).toEqual<SecondLocusDistinctnessResult>({ ok: true })

    // describeStages consumes all three input keys: the matching tier overrides
    // the 'ordering' stage's required group (BuiltStage shape, camelCase).
    expect(strategy.describeStages(stageInput({ amountCents: 60_000 }))).toEqual([
      { stageIndex: 0, role: 'reviewer', requiredGroup: 'group-review', certifies: ['substantive', 'arithmetical'] },
      { stageIndex: 1, role: 'authoriser', requiredGroup: 'group-plenum', certifies: ['ordering'] },
    ])
  })

  it('unknown strategy id: throws a typed error, never a permissive fallback', () => {
    // This actor is group-eligible, NOT the creator, and NOT a duplicate signer —
    // ANY permissive fallback (a default strategy or an implicit { ok: true })
    // would let the signature through. The typed throw at resolution proves the
    // seam is fail-closed.
    const stages = [stageState({ id: 21 }), stageState({ id: 22, requiredGroup: 'group-authorise' })]
    expect(() =>
      resolveSecondLocusStrategy('m_of_n').validateDistinctness(
        stages,
        { userId: 'u-clean-signer', groups: ['group-review'] },
        { createdBy: 'u-someone-else' },
        stages[0],
      ),
    ).toThrow(UnknownSecondLocusStrategyError)
  })

  it('re-registering the same id replaces the prior strategy (idempotent module re-import)', () => {
    const first = stubStrategy()
    const second = stubStrategy()
    registerSecondLocusStrategy('module:m_of_n', first)
    registerSecondLocusStrategy('module:m_of_n', second)
    expect(resolveSecondLocusStrategy('module:m_of_n')).toBe(second)
    expect(resolveSecondLocusStrategy('module:m_of_n')).not.toBe(first)
  })

  it('the kernel reserves no ids: any vertical id (incl. the shipped "vier-augen") registers unconditionally', () => {
    // The decision-rule seam reserves core ids; this seam deliberately does NOT
    // — a vertical owns its strategy ids. Registering under the finance id
    // 'vier-augen' is a plain register, never a throw.
    const strategy = stubStrategy()
    registerSecondLocusStrategy('vier-augen', strategy)
    expect(resolveSecondLocusStrategy('vier-augen')).toBe(strategy)
  })

  it('_resetRuntimeRegistryForTests() clears the second-locus registry', () => {
    registerSecondLocusStrategy('module:m_of_n', stubStrategy())
    expect(resolveSecondLocusStrategy('module:m_of_n')).toBeDefined()
    _resetRuntimeRegistryForTests()
    expect(() => resolveSecondLocusStrategy('module:m_of_n')).toThrow(UnknownSecondLocusStrategyError)
  })
})
