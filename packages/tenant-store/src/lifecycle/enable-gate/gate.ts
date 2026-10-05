// packages/tenant-store/src/lifecycle/enable-gate/gate.ts
//
// TASK-044 (PRD-PLAT-012, TRD-060, TRD-063, TRD-161, FLOW-OPS-003): the
// level-1 enable gate enableModule takes as deps.enableGate. It answers for one
// (customer, module) BEFORE anything is written (enable.ts step 3), and either
// returns the two references the enablement row records or throws
// EnableRefused naming the module, the customer and the release tip:
//
//   NO_RELEASE_TIP       the release tip is unset or not 40/64 lowercase hex
//                        (checked first, before any query)
//   NO_ISOLATION_RESULT  no cross_customer result for the module
//   ISOLATION_FAILED     the LATEST result (run_at) failed: a newer fail beats
//                        an older pass
//   ISOLATION_STALE_TIP  the latest result passed on another release tip
//   FIXTURE_EVIDENCE     the latest pass is scratch-fixture evidence (Q6) and
//                        this gate was not built for a scratch stack
//   NO_DPIA_DECISION     no ops.dpia_decision for (customer, module), or the
//                        latest one carries no document_ref (Q3: whatever
//                        requires_dpia says, the decision is written down)
//
// The null path of EnableGate stays enableModule's GATE_REFUSED; this gate
// never returns null. The database backstop is the NOT VALID foreign key on
// module_enablement (0006): a reference to a failed result, another module's
// result or an unknown id is 23503. The gate reads, the backstop re-checks at
// write time; a newer failing result recorded between the two (step 3 and
// step 8 of enableModule) is not caught by the key (accepted, lane note A2).
import type { Sql } from '@gremion/db'
import type { EnableGate, GateResult } from '../types.js'

/** SCHEMA isolation_test_result_release_tip_sha_check: a full SHA-1 or SHA-256 commit id. */
export const RELEASE_TIP = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/** Q6: evidence rows a scratch stack seeds (scratch-fixture.sql) carry this prefix. */
export const FIXTURE_EVIDENCE_PREFIX = 'scratch-fixture:'

export const ENABLE_REFUSED_CODES = [
  'NO_RELEASE_TIP',
  'NO_ISOLATION_RESULT',
  'ISOLATION_FAILED',
  'ISOLATION_STALE_TIP',
  'FIXTURE_EVIDENCE',
  'NO_DPIA_DECISION',
] as const
export type EnableRefusedCode = (typeof ENABLE_REFUSED_CODES)[number]

/**
 * A refused enable (Q2): `code` for machines, `reason` for the operator. The
 * message is `<code>: <reason>`; the CLI prints it on stderr and exits 1.
 */
export class EnableRefused extends Error {
  override name = 'EnableRefused'
  constructor(
    readonly code: EnableRefusedCode,
    readonly reason: string,
    readonly moduleKey: string,
    readonly customerId: string | null,
    readonly tipSha: string | null,
  ) {
    super(`${code}: ${reason}`)
  }
}

export interface EnableGateOptions {
  /** A connection to gremion_platform. */
  platform: Sql
  /**
   * The release tip the enable runs on: GREMION_RELEASE_TIP, derived on the
   * host from the H10-authenticated release tree (gremion-tenant tc()), never
   * from a request payload (lane note A6).
   */
  releaseTipSha: string | null | undefined
  /** Q6: accept `scratch-fixture:` evidence. Only a scratch stack sets it. */
  allowFixtureEvidence?: boolean
}

const who = (customerId: string | null) => (customerId === null ? 'a customer not created yet' : `customer ${customerId}`)

/** The tip, or NO_RELEASE_TIP. Synchronous: no query runs for an unset tip. */
export function assertReleaseTip(tip: string | null | undefined, moduleKey: string, customerId: string | null): string {
  if (typeof tip !== 'string' || !RELEASE_TIP.test(tip)) {
    const shown = typeof tip === 'string' && tip.length > 0 ? `${JSON.stringify(tip.slice(0, 80))} is not a full lowercase commit id (40 or 64 hex)` : 'is unset'
    throw new EnableRefused(
      'NO_RELEASE_TIP',
      `module ${moduleKey} for ${who(customerId)}: the release tip (GREMION_RELEASE_TIP, derived from the authenticated release tree) ${shown}; an isolation pass is recorded against a tip, so nothing can be enabled without one`,
      moduleKey,
      customerId,
      null,
    )
  }
  return tip
}

interface LatestResult {
  id: string
  passed: boolean
  tip: string
  evidenceRef: string
  runAt: Date
}

async function latestIsolationResult(platform: Sql, moduleKey: string): Promise<LatestResult | null> {
  const rows = await platform<{ id: string; passed: boolean; tip: string; evidence_ref: string; run_at: Date }[]>`
    SELECT r.isolation_test_result_id::text AS id, r.passed, r.release_tip_sha AS tip, r.evidence_ref, r.run_at
      FROM plt.isolation_test_result r JOIN plt.module m ON m.module_id = r.module_id
     WHERE m.module_key = ${moduleKey} AND r.test_kind = 'cross_customer'
     ORDER BY r.run_at DESC, r.created_at DESC, r.isolation_test_result_id DESC
     LIMIT 1`
  const r = rows[0]
  return r ? { id: r.id, passed: r.passed, tip: r.tip, evidenceRef: r.evidence_ref, runAt: r.run_at } : null
}

/**
 * The customer-independent half of the gate: the module's latest
 * cross_customer result is a pass on `tip` (and not fixture evidence unless
 * allowed). Returns its id; throws EnableRefused.
 */
export async function provenIsolationResult(opts: EnableGateOptions, tip: string, moduleKey: string, customerId: string | null): Promise<string> {
  const latest = await latestIsolationResult(opts.platform, moduleKey)
  const refuse = (code: EnableRefusedCode, why: string) => new EnableRefused(code, `module ${moduleKey} for ${who(customerId)} on release tip ${tip}: ${why}`, moduleKey, customerId, tip)
  if (!latest) throw refuse('NO_ISOLATION_RESULT', 'no cross-customer isolation result is recorded for this module (TRD-060); run the isolation harness on this tip and import its evidence')
  if (!latest.passed) throw refuse('ISOLATION_FAILED', `the latest cross-customer isolation result (${latest.id}, run ${latest.runAt.toISOString()}) FAILED; a newer failure outranks any older pass`)
  if (latest.tip !== tip) {
    throw refuse('ISOLATION_STALE_TIP', `the latest cross-customer pass (${latest.id}) was recorded against release tip ${latest.tip}, not this release; re-run the isolation harness on ${tip}`)
  }
  if (latest.evidenceRef.startsWith(FIXTURE_EVIDENCE_PREFIX) && opts.allowFixtureEvidence !== true) {
    throw refuse('FIXTURE_EVIDENCE', `the latest pass (${latest.id}) is scratch-fixture evidence (${FIXTURE_EVIDENCE_PREFIX}...), which only a scratch stack accepts`)
  }
  return latest.id
}

export interface DpiaDecisionRow {
  dpiaDecisionId: string
  requiresDpia: 'yes' | 'no' | 'not_applicable'
  reasonCodes: string[]
  documentRef: string | null
  decidedAt: Date
}

/** The latest ops.dpia_decision for (customer, module) by decided_at, or null. */
export async function latestDpiaDecision(platform: Sql, customerId: string, moduleKey: string): Promise<DpiaDecisionRow | null> {
  const rows = await platform<{ id: string; requires_dpia: DpiaDecisionRow['requiresDpia']; reason_codes: string[]; document_ref: string | null; decided_at: Date }[]>`
    SELECT d.dpia_decision_id::text AS id, d.requires_dpia, d.reason_codes, d.document_ref, d.decided_at
      FROM ops.dpia_decision d JOIN plt.module m ON m.module_id = d.module_id
     WHERE d.customer_id = ${customerId} AND m.module_key = ${moduleKey}
     ORDER BY d.decided_at DESC, d.dpia_decision_id DESC
     LIMIT 1`
  const r = rows[0]
  return r ? { dpiaDecisionId: r.id, requiresDpia: r.requires_dpia, reasonCodes: r.reason_codes, documentRef: r.document_ref, decidedAt: r.decided_at } : null
}

/** The decision the gate accepts for (customer, module): its id; throws NO_DPIA_DECISION. */
export async function acceptedDpiaDecision(platform: Sql, tip: string, moduleKey: string, customerId: string): Promise<string> {
  const d = await latestDpiaDecision(platform, customerId, moduleKey)
  const refuse = (why: string) => new EnableRefused('NO_DPIA_DECISION', `module ${moduleKey} for customer ${customerId} on release tip ${tip}: ${why}`, moduleKey, customerId, tip)
  if (!d) throw refuse('no dated DPIA-applicability decision is recorded for this customer and module (TRD-161); record it (dpia-record) first')
  if (d.documentRef === null) {
    throw refuse(`the latest DPIA decision (${d.dpiaDecisionId}, ${d.requiresDpia}) names no document_ref: TRD-161 wants it written down and attached to the TOM annex, whatever requires_dpia says (brief Q3)`)
  }
  return d.dpiaDecisionId
}

/**
 * The level-1 gate (TRD-063): enableModule's deps.enableGate. Every refusal is
 * an EnableRefused thrown before enableModule writes anything.
 */
export function createEnableGate(opts: EnableGateOptions): EnableGate {
  if (!opts || typeof opts.platform !== 'function') throw new TypeError('createEnableGate needs { platform } (a gremion_platform connection)')
  return async (customerId: string, moduleKey: string): Promise<GateResult> => {
    const tip = assertReleaseTip(opts.releaseTipSha, moduleKey, customerId)
    const isolationTestResultId = await provenIsolationResult(opts, tip, moduleKey, customerId)
    const dpiaDecisionId = await acceptedDpiaDecision(opts.platform, tip, moduleKey, customerId)
    // TRD-088's cross_body result is TASK-115's: no module needs one yet.
    return { isolationTestResultId, dpiaDecisionId, crossBodyTestResultId: null }
  }
}

/**
 * The pre-flight a create runs BEFORE its first write (lane note D2): the
 * customer-independent half of the gate for every module it will enable, so a
 * stale tip or a missing pass fails before a realm exists.
 */
export async function assertIsolationProven(opts: EnableGateOptions, moduleKeys: readonly string[], customerId: string | null = null): Promise<void> {
  for (const moduleKey of moduleKeys) {
    const tip = assertReleaseTip(opts.releaseTipSha, moduleKey, customerId)
    await provenIsolationResult(opts, tip, moduleKey, customerId)
  }
}
