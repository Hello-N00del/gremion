// packages/provisioning/src/operator-gate.ts — the operator's enable list,
// checked BEFORE any write: every id known to the catalogue, none denied.
//
// TASK-044 replaced TASK-043's interim gate (operatorAllowGate, which answered
// with an operator attestation as both references): every enable now goes
// through lifecycle/enable-gate's createEnableGate (module-gate.ts). The deny
// list stays as belt and braces: vault is refused BY NAME before the gate is
// even asked, so a hand-inserted isolation result can never enable it (the real
// gate would refuse it anyway: no case covers it, brief Q4). Board was lifted
// from this list in the board wave of 2026-11-11: it has its own isolation case,
// so the gate (a passed cross_customer row on the pinned tip) decides it like
// every other module.
import { ProvisioningError } from './errors.ts'

/** Why each default-denied module is refused (the MODULE_DENIED message names it). */
export const DENY_REASONS: Readonly<Record<string, string>> = Object.freeze({
  vault: 'the password vault stays off for the pilot (PRD-PLAT-012 / PRD-REC-003) until its own isolation pass (TRD-064, TASK-058)',
})

/** Refused by name, before any write: vault (PRD-PLAT-012 / PRD-REC-003, R30 A1). */
export const DEFAULT_DENY: ReadonlySet<string> = new Set(Object.keys(DENY_REASONS))

/**
 * Validates the operator's --enable list against the catalogue BEFORE any
 * write: every id known, none denied (by name). Returns it sorted and unique.
 */
export function assertEnableList(ids: readonly string[], catalogueIds: readonly string[], deny: ReadonlySet<string> = DEFAULT_DENY): string[] {
  const known = new Set(catalogueIds)
  const out = [...new Set(ids)].sort()
  for (const id of out) {
    if (deny.has(id)) {
      throw new ProvisioningError('MODULE_DENIED', `module ${id} cannot be enabled: ${DENY_REASONS[id] ?? 'it is on the deny list'}`)
    }
    if (!known.has(id)) throw new ProvisioningError('MODULE_UNKNOWN', `module ${JSON.stringify(id)} is not in the catalogue (known: ${[...known].sort().join(', ')})`)
  }
  return out
}
