// services/kernel-api/src/authz/sweep.ts — sweepGrants (brief s.5.6, Q8): the
// time- and module-driven state changes the request path does not make. Deny
// is decided at request time (pdp.ts reads the window and the registry); the
// sweep keeps the rows and events true. Colour-safe: every change is a
// conditional UPDATE ... WHERE state = <expected> RETURNING, and only the
// returned rows emit, so two sweepers (or a retry) emit each change once.
//
//  1. activate  scheduled, valid_from passed          -> active   (granted again, higher version)
//  2. expire    active, valid_until passed            -> expired  (expired.v1)
//  3. module    open capability grants of a module that is no longer enabled
//               (M-OFF-2)                             -> revoked, reason module_disabled
//     and the module's capability rows -> module_disabled; re-enabling later makes the
//     capability available again but NEVER reopens a revoked grant (M-OFF-4).
import { CAPABILITIES } from './catalogue.ts'
import { emitGrantEvent, type GrantRow } from './events.ts'
import type { EnabledModules } from './pdp.ts'
import { inCustomerTx, type Sql } from './tx.ts'

export interface SweepResult {
  activated: number
  expired: number
  moduleRevoked: number
}

const COLS = `grant_id::text, body_id::text, subject_person_id::text, grant_kind, role_key, capability_key, resource_kind, resource_id::text, valid_from, valid_until,
              granter_kind, granted_by::text, source, state, revoked_at, revoke_reason, row_version`

export async function sweepGrants(sql: Sql, enabledModules: EnabledModules, customerId: string): Promise<SweepResult> {
  const enabled = await enabledModules(customerId)
  const disabledCaps = CAPABILITIES.filter((c) => c.moduleKey !== null && !enabled.has(c.moduleKey)).map((c) => c.key)
  const enabledCaps = CAPABILITIES.filter((c) => c.moduleKey === null || enabled.has(c.moduleKey)).map((c) => c.key)
  return inCustomerTx(sql, customerId, async (tx) => {
    const activated = await tx.unsafe<GrantRow[]>(
      `UPDATE idt.authz_grant SET state = 'active', updated_by_kind = 'system', updated_by = NULL
        WHERE state = 'scheduled' AND valid_from <= now() RETURNING ${COLS}`,
    )
    for (const g of activated) await emitGrantEvent(tx, 'granted', g)
    const expired = await tx.unsafe<GrantRow[]>(
      `UPDATE idt.authz_grant SET state = 'expired', updated_by_kind = 'system', updated_by = NULL
        WHERE state = 'active' AND valid_until IS NOT NULL AND valid_until <= now() RETURNING ${COLS}`,
    )
    for (const g of expired) await emitGrantEvent(tx, 'expired', g)
    let moduleRevoked: GrantRow[] = []
    if (disabledCaps.length) {
      moduleRevoked = await tx.unsafe<GrantRow[]>(
        `UPDATE idt.authz_grant SET state = 'revoked', revoked_at = now(), revoked_by_kind = 'system', revoked_by = NULL, revoke_reason = 'module_disabled',
                updated_by_kind = 'system', updated_by = NULL
          WHERE state IN ('scheduled', 'active') AND grant_kind = 'capability' AND capability_key = ANY ($1::text[]) RETURNING ${COLS}`,
        [disabledCaps] as never[],
      )
      for (const g of moduleRevoked) await emitGrantEvent(tx, 'revoked', g)
      await tx`UPDATE idt.capability SET state = 'module_disabled', updated_by_kind = 'system' WHERE capability_key = ANY (${tx.array(disabledCaps)}::text[]) AND state <> 'module_disabled'`
    }
    // an enabled module's capabilities are available again (grants stay revoked, M-OFF-4)
    await tx`UPDATE idt.capability SET state = 'available', updated_by_kind = 'system'
              WHERE capability_key = ANY (${tx.array(enabledCaps)}::text[]) AND state = 'module_disabled'`
    return { activated: activated.length, expired: expired.length, moduleRevoked: moduleRevoked.length }
  })
}
