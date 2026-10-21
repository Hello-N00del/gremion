// packages/tenant-store/src/lifecycle/enable-gate/dpia.ts
//
// TASK-044 (TRD-161, DB-OPS-DPIA-DECISION, brief Q3): the dated, written
// DPIA-applicability decision for one (customer, module). Append-only: a new
// decision supersedes the old one by decided_at; nothing is ever updated.
// document_ref is required here for EVERY requires_dpia value (Q3: "dated,
// written ... attached to the TOM annex"), stricter than the table, which
// requires it for `yes` only (SCHEMA dpia_decision_document_required_check).
import type { Sql } from '@gremion/db'
import { assertUuid, LifecycleError } from '../guards.js'
import { assertPlatform, lookupModuleId } from '../platform.js'
import type { Actor } from '../types.js'
import { latestDpiaDecision } from './gate.js'

export const REQUIRES_DPIA = ['yes', 'no', 'not_applicable'] as const
export type RequiresDpia = (typeof REQUIRES_DPIA)[number]

/** SCHEMA dpia_decision_reason_codes_check, one code. */
export const REASON_CODE = /^[a-z][a-z0-9_]{0,62}$/

export interface DpiaDecisionInput {
  customerId: string
  moduleKey: string
  requiresDpia: RequiresDpia
  /** 1-20 snake_case codes (PRD-REG-005). */
  reasonCodes: readonly string[]
  /** The TOM-annex entry the written decision lives in (1-500 printable characters). */
  documentRef: string
  /** Who decided: an operator (the create request) or a person. */
  decidedBy: Actor
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** Throws LifecycleError INVALID_INPUT naming the first problem; nothing is queried. */
export function assertDpiaDecisionInput(input: DpiaDecisionInput): void {
  const bad = (m: string) => {
    throw new LifecycleError('INVALID_INPUT', `DPIA decision: ${m}`)
  }
  if (!input || typeof input !== 'object') bad('no input')
  assertUuid(input.customerId, 'DPIA decision customerId')
  if (typeof input.moduleKey !== 'string' || !/^[a-z][a-z_]{1,39}$/.test(input.moduleKey)) bad(`module ${JSON.stringify(input.moduleKey)} is not a module key`)
  if (!(REQUIRES_DPIA as readonly string[]).includes(input.requiresDpia)) bad(`requires_dpia ${JSON.stringify(input.requiresDpia)} is not one of ${REQUIRES_DPIA.join(', ')}`)
  const codes = input.reasonCodes
  if (!Array.isArray(codes) || codes.length < 1 || codes.length > 20) bad('reason_codes needs 1-20 codes')
  for (const c of codes) if (typeof c !== 'string' || !REASON_CODE.test(c)) bad(`reason code ${JSON.stringify(c)} is not snake_case (^[a-z][a-z0-9_]{0,62}$)`)
  const ref = input.documentRef
  if (typeof ref !== 'string' || ref.trim().length < 1 || ref.length > 500 || CONTROL.test(ref)) {
    bad('document_ref (the TOM-annex entry, 1-500 printable characters) is required for every decision, whatever requires_dpia says (TRD-161, brief Q3)')
  }
  if (!input.decidedBy || (input.decidedBy.kind !== 'operator' && input.decidedBy.kind !== 'person')) bad('decidedBy.kind must be operator or person')
  assertUuid(input.decidedBy.id, 'DPIA decision decidedBy.id')
}

const sameDecision = (a: { requiresDpia: string; reasonCodes: readonly string[]; documentRef: string | null }, b: DpiaDecisionInput) =>
  a.requiresDpia === b.requiresDpia && a.documentRef === b.documentRef && JSON.stringify([...a.reasonCodes]) === JSON.stringify([...b.reasonCodes])

/**
 * Appends the decision (decided_at = now()). With `reuseIdentical`, a latest
 * decision for the pair with the same requires_dpia, reason codes and
 * document_ref is returned instead (a resumed create must not mint a new
 * decision every run). Returns its id and whether a row was written.
 */
export async function recordDpiaDecision(platform: Sql, input: DpiaDecisionInput, opts: { reuseIdentical?: boolean } = {}): Promise<{ dpiaDecisionId: string; created: boolean }> {
  assertDpiaDecisionInput(input)
  await assertPlatform(platform)
  const moduleId = await lookupModuleId(platform, input.moduleKey)
  if (!moduleId) throw new LifecycleError('MODULE_UNKNOWN', `DPIA decision: plt.module has no module ${input.moduleKey}`)
  if (opts.reuseIdentical) {
    const latest = await latestDpiaDecision(platform, input.customerId, input.moduleKey)
    if (latest && sameDecision(latest, input)) return { dpiaDecisionId: latest.dpiaDecisionId, created: false }
  }
  const [row] = await platform<{ id: string }[]>`
    INSERT INTO ops.dpia_decision (customer_id, module_id, requires_dpia, reason_codes, document_ref, decided_by_kind, decided_by)
    VALUES (${input.customerId}, ${moduleId}, ${input.requiresDpia}, ${[...input.reasonCodes]}, ${input.documentRef},
            ${input.decidedBy.kind}, ${input.decidedBy.id})
    RETURNING dpia_decision_id::text AS id`
  if (!row) throw new LifecycleError('CONCURRENT_STATE', 'DPIA decision: the insert returned no row')
  return { dpiaDecisionId: row.id, created: true }
}
