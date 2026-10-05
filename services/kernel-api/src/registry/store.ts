// services/kernel-api/src/registry/store.ts — the module registry, read-only,
// in gremion_platform (DB-PLT-MODULE-ENABLEMENT, DB-PLT-MODULE-VERSION).
//
// The kernel API ADOPTS the plt.module / plt.module_version rows
// `gremion-tenant init` loads (TASK-043 loadCatalogueRows, lane note C1):
// startup writes nothing. Version status is NOT filtered (the rows stay
// `draft` until TASK-044's isolation evidence, module_version_activation_check);
// what makes a module served is the customer's enablement row in state
// 'enabled', whose gate check guarantees the evidence ids.
//
// TRD-082: both queries carry customer_id = the resolved customer (the query
// recorder test pins it; "all modules" or a missing predicate goes RED).
import type { Sql } from '@gremion/db'
import type { EnabledModuleRow, RegistryStore } from '../app/deps.ts'

export function platformRegistryStore(platform: Sql): RegistryStore {
  return {
    async listEnabled(customerId) {
      const rows = await platform<{ module_key: string; semver: string }[]>`
        SELECT m.module_key, v.semver
          FROM plt.module_enablement e
          JOIN plt.module m ON m.module_id = e.module_id
          JOIN plt.module_version v ON v.module_version_id = e.module_version_id AND v.module_id = e.module_id
         WHERE e.customer_id = ${customerId}::uuid AND e.state = 'enabled'
         ORDER BY m.module_key`
      return rows.map((r): EnabledModuleRow => ({ moduleKey: r.module_key, semver: r.semver }))
    },
    async isEnabled(customerId, moduleKey) {
      const rows = await platform`
        SELECT 1
          FROM plt.module_enablement e JOIN plt.module m ON m.module_id = e.module_id
         WHERE e.customer_id = ${customerId}::uuid AND m.module_key = ${moduleKey} AND e.state = 'enabled'`
      return rows.length === 1
    },
  }
}
