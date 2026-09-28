// test/approval.store.test.ts — mocked-PG unit test for the Vier-Augen approval
// family (#383 Lane C / R3). Mirrors services/write/approval-workflow.ts +
// approval-stages.ts + errors.ts:
//   - buildStages / resolveTier: the pure stage-generation + decision-authority
//     tier resolution (the KV→HV default profile, tier override on the ordering
//     'anordnung' stage).
//   - createApproval / signApproval / rejectApproval: the per-stage guards
//     (NoActiveProfile, AlreadyDecided, Helios-not-signable, WrongStage,
//     NotEligible, SelfApproval, DuplicateSigner, RejectionNoteRequired), each
//     throwing the typed ApprovalWorkflowError the route maps to its HTTP status.
//
// The full happy-path state machine (multi-stage sign → payment_order authorise →
// expense approved; reject voids the pending order) is proven end-to-end against a
// REAL ephemeral Postgres in test/api.integration.test.ts — this file covers the
// pure logic + the guard branches that throw BEFORE any write.

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  buildStages,
  resolveTier,
  createApproval,
  signApproval,
  rejectApproval,
  parseApprovalMethod,
  toPendingApprovalDto,
  type ActorContext,
  type SignerStageDef,
  type Tier,
} from '../src/store/index.ts'
import type { Sql } from '../src/tenant-store.ts'

// ── pure: buildStages + resolveTier (mirror approval-stages.ts) ──────────────────
const KV_HV: SignerStageDef[] = [
  { role: 'KV', required_group: 'ref-finanzen-kv', certifies: ['sachlich', 'rechnerisch'] },
  { role: 'HV', required_group: 'ref-finanzen-hv', certifies: ['anordnung'] },
]

describe('approval store — buildStages (default KV→HV profile)', () => {
  it('maps the ordered signer stages to insertable rows (no tier)', () => {
    expect(buildStages(KV_HV, undefined)).toEqual([
      { stageIndex: 0, role: 'KV', requiredGroup: 'ref-finanzen-kv', certifies: ['sachlich', 'rechnerisch'] },
      { stageIndex: 1, role: 'HV', requiredGroup: 'ref-finanzen-hv', certifies: ['anordnung'] },
    ])
  })

  it('a tier overrides ONLY the ordering (anordnung) stage required_group; stage count unchanged', () => {
    const tier: Tier = { max_amount_cents: null, required_group: 'organ-plenum' }
    const stages = buildStages(KV_HV, tier)
    expect(stages).toHaveLength(2)
    expect(stages[0]!.requiredGroup).toBe('ref-finanzen-kv') // KV (certifies sachlich/rechnerisch) untouched
    expect(stages[1]!.requiredGroup).toBe('organ-plenum') // HV (certifies anordnung) overridden
  })
})

describe('approval store — resolveTier', () => {
  const tiers: Tier[] = [
    { max_amount_cents: 50000, required_group: 'ref-finanzen-hv' },
    { max_amount_cents: 200000, required_group: 'organ-ausschuss' },
    { max_amount_cents: null, required_group: 'organ-plenum' }, // open-top
  ]
  it('returns the first tier whose max is null or >= the amount (sorted ascending)', () => {
    expect(resolveTier(tiers, 40000)!.required_group).toBe('ref-finanzen-hv')
    expect(resolveTier(tiers, 50000)!.required_group).toBe('ref-finanzen-hv') // boundary inclusive
    expect(resolveTier(tiers, 120000)!.required_group).toBe('organ-ausschuss')
    expect(resolveTier(tiers, 9_000_000)!.required_group).toBe('organ-plenum') // open-top
  })
  it('empty tiers → undefined (no override)', () => {
    expect(resolveTier([], 12345)).toBeUndefined()
  })
})

// ── fake PG with .begin, query-routed by regex ───────────────────────────────────
interface FakeOpts {
  approval?: Record<string, unknown> | null
  stages?: Array<Record<string, unknown>>
  profile?: Array<Record<string, unknown>> // finanzordnung_profile rows (empty → NO_ACTIVE_PROFILE)
  project?: Record<string, unknown> | null
}
function fakeSql(opts: FakeOpts) {
  const calls: Array<{ q: string; values: unknown[] }> = []
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim()
    calls.push({ q, values })
    if (/FROM finance\.approval WHERE id/.test(q)) return Promise.resolve(opts.approval ? [opts.approval] : [])
    if (/FROM finance\.approval_stage WHERE approval_id/.test(q)) return Promise.resolve(opts.stages ?? [])
    if (/FROM finance\.finanzordnung_profile/.test(q)) return Promise.resolve(opts.profile ?? [])
    if (/FROM finance\.project WHERE id/.test(q)) return Promise.resolve(opts.project ? [opts.project] : [])
    if (/INSERT INTO finance\.approval /.test(q)) {
      return Promise.resolve([{ id: '100', approvable_type: 'project', approvable_id: '5', created_by: 'creator', amount_cents: null, status: 'pending', current_stage_index: 0, method: 'manual' }])
    }
    return Promise.resolve([])
  }) as unknown as Sql & { begin: (cb: (tx: unknown) => unknown) => Promise<unknown> }
  ;(fn as unknown as { begin: (cb: (tx: unknown) => unknown) => Promise<unknown> }).begin = async (
    cb: (tx: unknown) => unknown,
  ) => cb(fn)
  return { fn, calls }
}

// Actor with BOTH signer groups (so a group check never masks a self/duplicate one).
const SIGNER: ActorContext = {
  userId: 'signer-1', isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [],
  groups: ['ref-finanzen-kv', 'ref-finanzen-hv'],
}
const SUPERUSER: ActorContext = {
  userId: 'su', isAuditor: false, isSuperuser: true, scopedOrgUnitIds: [], groups: [],
}
const STEP = { note: undefined, stepUpLoa: null, stepUpAt: null }

const PENDING_APPROVAL = {
  id: '9', approvable_type: 'expense', approvable_id: '10', created_by: 'creator',
  amount_cents: '0', status: 'pending', current_stage_index: 0, method: 'manual',
}
const STAGE0 = {
  id: '21', approval_id: '9', stage_index: 0, role: 'KV', required_group: 'ref-finanzen-kv',
  certifies: ['sachlich', 'rechnerisch'], state: 'pending', signer_user_id: null, acted_at: null, note: null,
  step_up_loa: null, step_up_at: null,
}
const STAGE1 = {
  id: '22', approval_id: '9', stage_index: 1, role: 'HV', required_group: 'ref-finanzen-hv',
  certifies: ['anordnung'], state: 'pending', signer_user_id: null, acted_at: null, note: null,
  step_up_loa: null, step_up_at: null,
}

describe('approval store — createApproval guards', () => {
  it('throws NoActiveProfileError (NO_ACTIVE_PROFILE) when no finanzordnung_profile row exists', async () => {
    const { fn } = fakeSql({ project: { org_unit_id: 'ou-x' }, profile: [] })
    await expect(
      createApproval(fn, SUPERUSER, { approvableType: 'project', approvableId: 5 }),
    ).rejects.toMatchObject({ code: 'NO_ACTIVE_PROFILE', httpStatus: 500 })
  })

  it('refuses an auditor at the create-time write-scope gate (AccessDenied)', async () => {
    const auditor: ActorContext = { userId: 'aud', isAuditor: true, isSuperuser: false, scopedOrgUnitIds: [], groups: [] }
    const { fn } = fakeSql({ project: { org_unit_id: 'ou-x' }, profile: [] })
    await expect(
      createApproval(fn, auditor, { approvableType: 'project', approvableId: 5 }),
    ).rejects.toMatchObject({ name: 'AccessDeniedError' })
  })
})

describe('approval store — signApproval guards (throw before any write)', () => {
  it('AlreadyDecidedError (ALREADY_DECIDED 409) when the approval is not pending', async () => {
    const { fn } = fakeSql({ approval: { ...PENDING_APPROVAL, status: 'approved' } })
    await expect(signApproval(fn, SIGNER, 9, STEP)).rejects.toMatchObject({ code: 'ALREADY_DECIDED', httpStatus: 409 })
  })

  it('HeliosApprovalNotManuallySignable (HELIOS_NOT_MANUALLY_SIGNABLE 403) for a helios approval', async () => {
    const { fn } = fakeSql({ approval: { ...PENDING_APPROVAL, method: 'helios' }, stages: [STAGE0, STAGE1] })
    await expect(signApproval(fn, SIGNER, 9, STEP)).rejects.toMatchObject({ code: 'HELIOS_NOT_MANUALLY_SIGNABLE', httpStatus: 403 })
  })

  it('WrongStageError (WRONG_STAGE 409) when the current-index stage is not pending', async () => {
    const { fn } = fakeSql({ approval: { ...PENDING_APPROVAL, current_stage_index: 0 }, stages: [{ ...STAGE0, state: 'approved' }, STAGE1] })
    await expect(signApproval(fn, SIGNER, 9, STEP)).rejects.toMatchObject({ code: 'WRONG_STAGE', httpStatus: 409 })
  })

  it('NotEligibleForStage (NOT_ELIGIBLE 403) when the actor lacks the stage required_group', async () => {
    const wrongGroup: ActorContext = { ...SIGNER, groups: ['ref-finanzen-hv'] } // stage0 needs KV
    const { fn } = fakeSql({ approval: PENDING_APPROVAL, stages: [STAGE0, STAGE1] })
    await expect(signApproval(fn, wrongGroup, 9, STEP)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE', httpStatus: 403 })
  })

  it('SelfApprovalForbidden (SELF_APPROVAL 403) when the signer is the approval creator', async () => {
    const creator: ActorContext = { ...SIGNER, userId: 'creator' } // = PENDING_APPROVAL.created_by
    const { fn } = fakeSql({ approval: PENDING_APPROVAL, stages: [STAGE0, STAGE1] })
    await expect(signApproval(fn, creator, 9, STEP)).rejects.toMatchObject({ code: 'SELF_APPROVAL', httpStatus: 403 })
  })

  it('DuplicateSignerForbidden (DUPLICATE_SIGNER 403) when the actor already signed an earlier stage', async () => {
    // Signing stage 1; stage 0 already carries this actor as signer → duplicate.
    const approval = { ...PENDING_APPROVAL, current_stage_index: 1 }
    const stages = [{ ...STAGE0, state: 'approved', signer_user_id: 'signer-1' }, STAGE1]
    const { fn } = fakeSql({ approval, stages })
    await expect(signApproval(fn, SIGNER, 9, STEP)).rejects.toMatchObject({ code: 'DUPLICATE_SIGNER', httpStatus: 403 })
  })
})

describe('approval store — rejectApproval note guard', () => {
  it('RejectionNoteRequired (REJECTION_NOTE_REQUIRED 400) for an empty/whitespace note', async () => {
    const { fn } = fakeSql({ approval: PENDING_APPROVAL, stages: [STAGE0, STAGE1] })
    await expect(rejectApproval(fn, SIGNER, 9, { note: '   ', stepUpLoa: null, stepUpAt: null })).rejects.toMatchObject({
      code: 'REJECTION_NOTE_REQUIRED', httpStatus: 400,
    })
  })
})

// House review (FU3 round 2, HIGH): `finance.approval.method` is TEXT with a
// migration-001 CHECK (method IN ('manual','helios')) constraint, but
// postgres-js's `sql<RawPendingApprovalRow[]>` generic is compile-time-only —
// nothing at runtime stops a schema-drift value from reaching listPendingApprovals'
// mapper. Silently falling through as 'manual' would be the dangerous
// direction (it is what gates gremion-ui's Freigeben button), so an
// unrecognised value must fail closed as 'helios' instead, logged loudly.
describe('approval store — parseApprovalMethod (fail-closed boundary parse)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes through the two valid values unchanged', () => {
    expect(parseApprovalMethod('manual', 'approval 1')).toBe('manual')
    expect(parseApprovalMethod('helios', 'approval 1')).toBe('helios')
  })

  it('an unrecognised value fails closed as "helios" and logs loudly, naming the context', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(parseApprovalMethod('bogus', 'approval 7')).toBe('helios')
    expect(errSpy).toHaveBeenCalledOnce()
    const [line] = errSpy.mock.calls[0]!
    expect(String(line)).toMatch(/approval 7/)
    expect(String(line)).toMatch(/bogus/)
  })
})

describe('approval store — toPendingApprovalDto method boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const baseRow = {
    id: 1, approvable_type: 'expense', approvable_id: 42, approvable_title: null,
    created_by: 'u-1', status: 'pending', created_at: null,
    amount_cents: null, current_stage_index: 0, stages: [],
  }

  it('a valid method passes through onto the DTO', () => {
    expect(toPendingApprovalDto({ ...baseRow, method: 'helios' } as never).method).toBe('helios')
  })

  it('an unrecognised method fails closed as "helios" on the DTO, not a silent "manual"', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(toPendingApprovalDto({ ...baseRow, method: 'bogus' } as never).method).toBe('helios')
    expect(errSpy).toHaveBeenCalledOnce()
  })
})
