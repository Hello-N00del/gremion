// packages/provisioning/src/operator-gate.ts — the INTERIM level-1 enable gate
// (TASK-043 Q19; a named deviation from PRD-PLAT-012 / TRD-063 that TASK-044
// replaces by swapping this import for lifecycle/enable-gate).
//
// @gremion/tenant-store's enableModule refuses without an injected gate and
// has no implementation of one (types.ts: "TASK-044 implements it"). Until
// TASK-044 lands, the only basis for an enable is the operator's explicit
// --enable list. The gate therefore answers:
//   - null for an id the operator did not pass (enableModule -> GATE_REFUSED);
//   - null for a denied id, even when the operator passed it: board (not
//     tenant-isolated until TASK-058 / R29-BOARD-STORE-K, R29-I1) and vault
//     (PRD-PLAT-012 / PRD-REC-003: the platform shall not enable the tasks
//     board or the password vault for the pilot; vault stays off until its own
//     isolation pass, TRD-064 / TASK-058; R30 addendum A1 of TASK-043c);
//   - otherwise the ONE attestation id persisted for (customer, module)
//     before the enable (plt.operator_enable_attestation, 0004), as BOTH
//     references -- never a fresh random uuid per call, so a resumed enable
//     writes the same references and the rows stay traceable.
// TASK-044 hand-off: these references name no plt.isolation_test_result row;
// its ALTER TABLE ... ADD FOREIGN KEY must re-gate or backfill them, or add the
// key NOT VALID. provisioningStatus lists them.
import type { EnableGate } from '@gremion/tenant-store/lifecycle'
import { ProvisioningError } from './errors.ts'

/** Why each default-denied module is refused (the MODULE_DENIED message names it). */
export const DENY_REASONS: Readonly<Record<string, string>> = Object.freeze({
  board: 'it is not tenant-isolated yet (R29-I1; TASK-058 / R29-BOARD-STORE-K)',
  vault: 'the password vault stays off for the pilot (PRD-PLAT-012 / PRD-REC-003) until its own isolation pass (TRD-064, TASK-058)',
})

/** Refused by name, before any write: board (R29-I1) and vault (PRD-PLAT-012 / PRD-REC-003, R30 A1). */
export const DEFAULT_DENY: ReadonlySet<string> = new Set(Object.keys(DENY_REASONS))

/** The attestation note every interim row carries (Q19). */
export const INTERIM_GATE_BASIS = 'interim gate, no isolation test (TASK-044)'

/**
 * Validates the operator's --enable list against the catalogue BEFORE any
 * write: every id known, none denied (by name). Returns it sorted and unique.
 */
export function assertEnableList(ids: readonly string[], catalogueIds: readonly string[], deny: ReadonlySet<string> = DEFAULT_DENY): string[] {
  const known = new Set(catalogueIds)
  const out = [...new Set(ids)].sort()
  for (const id of out) {
    if (deny.has(id)) {
      throw new ProvisioningError('MODULE_DENIED', `module ${id} cannot be enabled: ${DENY_REASONS[id] ?? 'it is on the interim deny list'}`)
    }
    if (!known.has(id)) throw new ProvisioningError('MODULE_UNKNOWN', `module ${JSON.stringify(id)} is not in the catalogue (known: ${[...known].sort().join(', ')})`)
  }
  return out
}

/** Reads the persisted attestation id for (customer, module), or null. */
export type AttestationLookup = (customerId: string, moduleId: string) => Promise<string | null>

export function operatorAllowGate(
  enabled: ReadonlySet<string>,
  lookup: AttestationLookup,
  deny: ReadonlySet<string> = DEFAULT_DENY,
): EnableGate {
  return async (tenantId, moduleId) => {
    if (deny.has(moduleId) || !enabled.has(moduleId)) return null
    const id = await lookup(tenantId, moduleId)
    if (!id) return null
    return { isolationTestResultId: id, dpiaDecisionId: id }
  }
}
