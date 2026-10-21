// services/kernel-api/src/authz/sync.ts — syncAuthzCatalogue (brief s.5.2, Q6):
// idempotent upsert of the catalogue's roles and capabilities into one
// customer's kernel database, run after migrate and by `kernel-api authz sync`.
//
// Module-awareness (operator decision 2026-10-21, M-OFF-1/3):
//  - a capability of a module that is NOT enabled is written (or kept) with
//    state 'module_disabled': inert, kept for audit;
//  - a module the build/registry does not know at all (`moduleIds` has no entry)
//    gets NO capability row (no dangling row, no boot failure);
//  - kernel (idt.*) capabilities need no module and are always 'available'.
import { CAPABILITIES, CATALOGUE_VERSION, ROLES } from './catalogue.ts'
import { inCustomerTx, type Sql } from './tx.ts'

export interface SyncInput {
  customerId: string
  /** plt.module.module_key -> module_id, for the modules this build/registry knows. */
  moduleIds: ReadonlyMap<string, string>
  /** module keys enabled for the customer right now (plt.module_enablement.state = 'enabled'). */
  enabledModules: ReadonlySet<string>
}

export interface SyncResult {
  roles: number
  capabilities: number
  /** capability keys with no row because their module is unknown to the registry */
  skipped: string[]
  /** capability keys written as module_disabled */
  disabled: string[]
}

export async function syncAuthzCatalogue(sql: Sql, input: SyncInput): Promise<SyncResult> {
  return inCustomerTx(sql, input.customerId, async (tx) => {
    for (const r of ROLES) {
      await tx`
        INSERT INTO idt.role (role_key, customer_id, label_de, label_en, scope_level, privileged, capability_keys, origin, state, created_by_kind, updated_by_kind)
        VALUES (${r.key}, ${input.customerId}::uuid, ${r.labelDe}, ${r.labelEn}, ${r.scopeLevel}, ${r.privileged}, ${tx.array([...r.capabilities])}::text[], 'vendor_default', 'active', 'system', 'system')
        ON CONFLICT (role_key) DO UPDATE
           SET label_de = EXCLUDED.label_de, label_en = EXCLUDED.label_en, scope_level = EXCLUDED.scope_level,
               privileged = EXCLUDED.privileged, capability_keys = EXCLUDED.capability_keys, updated_by_kind = 'system'
         WHERE (idt.role.label_de, idt.role.label_en, idt.role.scope_level, idt.role.privileged, idt.role.capability_keys, idt.role.state)
               IS DISTINCT FROM (EXCLUDED.label_de, EXCLUDED.label_en, EXCLUDED.scope_level, EXCLUDED.privileged, EXCLUDED.capability_keys, 'active')
               AND idt.role.origin = 'vendor_default'`
    }
    const skipped: string[] = []
    const disabled: string[] = []
    let capabilities = 0
    for (const c of CAPABILITIES) {
      let moduleId: string | null = null
      if (c.moduleKey) {
        moduleId = input.moduleIds.get(c.moduleKey) ?? null
        if (!moduleId) {
          skipped.push(c.key)
          continue
        }
      }
      const state = c.moduleKey === null || input.enabledModules.has(c.moduleKey) ? 'available' : 'module_disabled'
      if (state === 'module_disabled') disabled.push(c.key)
      await tx`
        INSERT INTO idt.capability (capability_key, customer_id, module_id, manifest_version, resource_kind, privileged, state, created_by_kind, updated_by_kind)
        VALUES (${c.key}, ${input.customerId}::uuid, ${moduleId}::uuid, ${CATALOGUE_VERSION}, ${c.resourceKind ?? null}, ${c.privileged}, ${state}, 'system', 'system')
        ON CONFLICT (capability_key) DO UPDATE
           SET module_id = EXCLUDED.module_id, manifest_version = EXCLUDED.manifest_version, resource_kind = EXCLUDED.resource_kind,
               privileged = EXCLUDED.privileged, state = EXCLUDED.state, updated_by_kind = 'system'
         WHERE (idt.capability.module_id, idt.capability.manifest_version, idt.capability.resource_kind, idt.capability.privileged, idt.capability.state)
               IS DISTINCT FROM (EXCLUDED.module_id, EXCLUDED.manifest_version, EXCLUDED.resource_kind, EXCLUDED.privileged, EXCLUDED.state)`
      capabilities++
    }
    if (skipped.length) {
      // a module the registry no longer knows: its earlier rows go inert, never stay 'available'
      await tx`UPDATE idt.capability SET state = 'module_disabled', updated_by_kind = 'system' WHERE capability_key = ANY (${tx.array(skipped)}::text[]) AND state <> 'module_disabled'`
    }
    return { roles: ROLES.length, capabilities, skipped, disabled }
  })
}
