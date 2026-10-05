// packages/tenant-store/src/lifecycle/enable-gate/regate.ts
//
// TASK-044 brief Q8 and lane note A3 (G10): what is ALREADY enabled.
//
//   unprovenEnablements      every enabled (customer, module) the gate would
//                            not let through on this tip, or whose stored
//                            references are not what the gate accepts (an
//                            interim attestation id, an older tip's pass, a
//                            dangling DPIA id). Exported as
//                            assertEnabledModulesProven too (deploy wiring is
//                            TASK-086's residual).
//   attestedEnablements      the TASK-043 interim rows (references = an
//                            plt.operator_enable_attestation id), A3's query.
//   regateEnablement         re-runs the real gate for one enabled pair and
//                            writes its references in one transaction.
//   validateGateForeignKeys  VALIDATEs the two NOT VALID enablement keys of
//                            0006 once no row violates them.
// plt.operator_enable_attestation stays as append-only history (K5); nothing
// reads it for gating any more.
import type { Sql } from '@gremion/db'
import { assertUuid, LifecycleError } from '../guards.js'
import { assertPlatform } from '../platform.js'
import type { Actor } from '../types.js'
import { createEnableGate, EnableRefused, FIXTURE_EVIDENCE_PREFIX, RELEASE_TIP, type EnableGateOptions, type EnableRefusedCode } from './gate.js'

export interface UnprovenEnablement {
  customerId: string
  moduleKey: string
  isolationTestResultId: string | null
  dpiaDecisionId: string | null
  /** Why, as gate codes: the gate's own verdict now, then what is wrong with the stored references. */
  codes: EnableRefusedCode[]
  reason: string
}

interface EnabledRow {
  customer_id: string
  module_key: string
  iso: string | null
  dpia: string | null
  ref_found: boolean
  ref_passed: boolean | null
  ref_module_ok: boolean | null
  ref_kind: string | null
  ref_tip: string | null
  ref_evidence: string | null
  dpia_found: boolean
  dpia_document: string | null
}

/**
 * Every enabled (customer, module) that is not proven on `releaseTipSha`:
 * empty means each enabled module holds a current-tip pass and a written DPIA
 * decision, referenced by its row. Read-only.
 */
export async function unprovenEnablements(opts: EnableGateOptions & { customerId?: string }): Promise<UnprovenEnablement[]> {
  await assertPlatform(opts.platform)
  if (opts.customerId !== undefined) assertUuid(opts.customerId, 'customerId')
  const rows = await opts.platform<EnabledRow[]>`
    SELECT e.customer_id::text, m.module_key,
           e.isolation_test_result_id::text AS iso, e.dpia_decision_id::text AS dpia,
           r.isolation_test_result_id IS NOT NULL AS ref_found, r.passed AS ref_passed,
           (r.module_id = e.module_id) AS ref_module_ok, r.test_kind AS ref_kind,
           r.release_tip_sha AS ref_tip, r.evidence_ref AS ref_evidence,
           d.dpia_decision_id IS NOT NULL AS dpia_found, d.document_ref AS dpia_document
      FROM plt.module_enablement e
      JOIN plt.module m ON m.module_id = e.module_id
      LEFT JOIN plt.isolation_test_result r ON r.isolation_test_result_id = e.isolation_test_result_id
      LEFT JOIN ops.dpia_decision d ON d.dpia_decision_id = e.dpia_decision_id
                                   AND d.customer_id = e.customer_id AND d.module_id = e.module_id
     WHERE e.state = 'enabled' AND (${opts.customerId ?? null}::uuid IS NULL OR e.customer_id = ${opts.customerId ?? null}::uuid)
     ORDER BY e.customer_id, m.module_key`
  const tip = typeof opts.releaseTipSha === 'string' && RELEASE_TIP.test(opts.releaseTipSha) ? opts.releaseTipSha : null
  const gate = createEnableGate(opts)
  const out: UnprovenEnablement[] = []
  for (const r of rows) {
    const codes: EnableRefusedCode[] = []
    const why: string[] = []
    // 1. the gate's verdict on this pair now
    try {
      await gate(r.customer_id, r.module_key)
    } catch (err) {
      if (!(err instanceof EnableRefused)) throw err
      codes.push(err.code)
      why.push(err.reason)
    }
    // 2. the references the row stores
    if (tip !== null) {
      if (!r.ref_found || r.ref_module_ok !== true || r.ref_kind !== 'cross_customer') {
        codes.push('NO_ISOLATION_RESULT')
        why.push(`the stored isolation reference ${r.iso ?? 'null'} names no cross-customer result of ${r.module_key} (an interim attestation id or a dangling id)`)
      } else if (r.ref_passed !== true) {
        codes.push('ISOLATION_FAILED')
        why.push(`the stored isolation reference ${r.iso} is a failed result`)
      } else if (r.ref_tip !== tip) {
        codes.push('ISOLATION_STALE_TIP')
        why.push(`the stored isolation reference ${r.iso} passed on ${r.ref_tip}, not ${tip}`)
      } else if (r.ref_evidence?.startsWith(FIXTURE_EVIDENCE_PREFIX) && opts.allowFixtureEvidence !== true) {
        codes.push('FIXTURE_EVIDENCE')
        why.push(`the stored isolation reference ${r.iso} is scratch-fixture evidence`)
      }
    }
    if (!r.dpia_found || r.dpia_document === null) {
      codes.push('NO_DPIA_DECISION')
      why.push(`the stored DPIA reference ${r.dpia ?? 'null'} names no written decision of this customer and module`)
    }
    if (codes.length) {
      out.push({ customerId: r.customer_id, moduleKey: r.module_key, isolationTestResultId: r.iso, dpiaDecisionId: r.dpia, codes: [...new Set(codes)], reason: why.join('; ') })
    }
  }
  return out
}

export class EnablementsUnproven extends Error {
  override name = 'EnablementsUnproven'
  constructor(readonly unproven: readonly UnprovenEnablement[]) {
    super(`${unproven.length} enabled module(s) lack a current-tip isolation pass or a written DPIA decision: ${unproven.map((u) => `${u.moduleKey} for ${u.customerId} (${u.codes.join(', ')})`).join('; ')}`)
  }
}

/** Q8: throws EnablementsUnproven naming each enabled module lacking a current-tip pass. */
export async function assertEnabledModulesProven(opts: EnableGateOptions & { customerId?: string }): Promise<void> {
  const unproven = await unprovenEnablements(opts)
  if (unproven.length) throw new EnablementsUnproven(unproven)
}

export interface AttestedEnablement {
  customerId: string
  moduleKey: string
  attestationId: string
  state: string | null
  enabledAt: Date | null
}

/** Lane note A3's read-only query: every interim attestation and the enablement still carrying it. */
export async function attestedEnablements(platform: Sql): Promise<AttestedEnablement[]> {
  await assertPlatform(platform)
  const rows = await platform<{ customer_id: string; module_key: string; attestation_id: string; state: string | null; enabled_at: Date | null }[]>`
    SELECT a.customer_id::text, a.module_key, a.attestation_id::text, e.state, e.enabled_at
      FROM plt.operator_enable_attestation a
      LEFT JOIN plt.module m ON m.module_key = a.module_key
      LEFT JOIN plt.module_enablement e ON e.customer_id = a.customer_id AND e.module_id = m.module_id
           AND (e.isolation_test_result_id = a.attestation_id OR e.dpia_decision_id = a.attestation_id)
     ORDER BY 1, 2`
  return rows.map((r) => ({ customerId: r.customer_id, moduleKey: r.module_key, attestationId: r.attestation_id, state: r.state, enabledAt: r.enabled_at }))
}

export interface RegateResult {
  customerId: string
  moduleKey: string
  before: { isolationTestResultId: string | null; dpiaDecisionId: string | null }
  after: { isolationTestResultId: string; dpiaDecisionId: string }
  updated: boolean
}

/**
 * Re-gates one ENABLED (customer, module): the real gate answers (throwing
 * EnableRefused when it refuses, the row untouched) and its references are
 * written into the row in one transaction (UPDATE is allowed on the
 * enablement; touch_row bumps row_version). A row already carrying exactly
 * those references is left alone.
 */
export async function regateEnablement(opts: EnableGateOptions & { customerId: string; moduleKey: string; actor: Actor }): Promise<RegateResult> {
  await assertPlatform(opts.platform)
  assertUuid(opts.customerId, 'customerId')
  if (!opts.actor || (opts.actor.kind !== 'operator' && opts.actor.kind !== 'person')) throw new LifecycleError('INVALID_INPUT', 'actor.kind must be person or operator')
  assertUuid(opts.actor.id, 'actor.id')
  const refs = await createEnableGate(opts)(opts.customerId, opts.moduleKey)
  if (!refs) throw new LifecycleError('GATE_REFUSED', `the gate refused (${opts.customerId}, ${opts.moduleKey})`)
  return opts.platform.begin(async (tx) => {
    const [row] = await tx<{ iso: string | null; dpia: string | null }[]>`
      SELECT e.isolation_test_result_id::text AS iso, e.dpia_decision_id::text AS dpia
        FROM plt.module_enablement e JOIN plt.module m ON m.module_id = e.module_id
       WHERE e.customer_id = ${opts.customerId} AND m.module_key = ${opts.moduleKey} AND e.state = 'enabled'
       FOR UPDATE OF e`
    if (!row) throw new LifecycleError('CONCURRENT_STATE', `(${opts.customerId}, ${opts.moduleKey}) is not enabled: nothing to re-gate`)
    const before = { isolationTestResultId: row.iso, dpiaDecisionId: row.dpia }
    const after = { isolationTestResultId: refs.isolationTestResultId, dpiaDecisionId: refs.dpiaDecisionId }
    if (row.iso === after.isolationTestResultId && row.dpia === after.dpiaDecisionId) {
      return { customerId: opts.customerId, moduleKey: opts.moduleKey, before, after, updated: false }
    }
    await tx`
      UPDATE plt.module_enablement e
         SET isolation_test_result_id = ${after.isolationTestResultId},
             cross_body_test_result_id = ${refs.crossBodyTestResultId ?? null},
             dpia_decision_id = ${after.dpiaDecisionId},
             updated_by_kind = ${opts.actor.kind}, updated_by = ${opts.actor.id}
        FROM plt.module m
       WHERE m.module_id = e.module_id AND e.customer_id = ${opts.customerId} AND m.module_key = ${opts.moduleKey} AND e.state = 'enabled'`
    return { customerId: opts.customerId, moduleKey: opts.moduleKey, before, after, updated: true }
  })
}

/** The two enablement keys 0006 adds NOT VALID. */
export const ENABLEMENT_GATE_KEYS = [
  { name: 'module_enablement_isol_result_id_module_id_kind_passed_fkey', column: 'isolation_test_result_id', kind: 'cross_customer' },
  { name: 'module_enablement_xbody_result_id_module_id_kind_passed_fkey', column: 'cross_body_test_result_id', kind: 'cross_body' },
] as const

export interface ValidateKeysResult {
  /** Keys this call validated. */
  validated: string[]
  /** Keys already valid. */
  alreadyValid: string[]
  /** Keys left NOT VALID, with the number of violating rows. */
  pending: { name: string; violators: number }[]
}

/**
 * VALIDATEs each NOT VALID enablement key that no row violates (needs the
 * table owner: the platform owner the container connects as). A key with
 * violators stays NOT VALID and is reported; nothing is changed for it.
 */
export async function validateGateForeignKeys(platform: Sql): Promise<ValidateKeysResult> {
  await assertPlatform(platform)
  const out: ValidateKeysResult = { validated: [], alreadyValid: [], pending: [] }
  for (const k of ENABLEMENT_GATE_KEYS) {
    const [c] = await platform<{ valid: boolean }[]>`
      SELECT convalidated AS valid FROM pg_constraint
       WHERE conname = ${k.name} AND conrelid = 'plt.module_enablement'::regclass`
    if (!c) throw new LifecycleError('TARGET_REFUSED', `plt.module_enablement has no constraint ${k.name}: is gremion_platform migrated past 0006?`)
    if (c.valid) {
      out.alreadyValid.push(k.name)
      continue
    }
    const [v] = await platform<{ n: number }[]>`
      SELECT count(*)::int AS n FROM plt.module_enablement e
       WHERE e.${platform(k.column)} IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM plt.isolation_test_result r
                          WHERE r.isolation_test_result_id = e.${platform(k.column)} AND r.module_id = e.module_id
                            AND r.test_kind = ${k.kind} AND r.passed)`
    const violators = v?.n ?? 0
    if (violators > 0) {
      out.pending.push({ name: k.name, violators })
      continue
    }
    await platform.unsafe(`ALTER TABLE plt.module_enablement VALIDATE CONSTRAINT ${k.name}`)
    out.validated.push(k.name)
  }
  return out
}
