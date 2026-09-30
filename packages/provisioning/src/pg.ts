// packages/provisioning/src/pg.ts — the gremion_platform adapters this
// package owns: the Q19 attestations, the modules port over TASK-021's
// enableModule, and bootstrapPlatform (Q15, `gremion-tenant init`).
import type { Sql } from '@gremion/db'
import {
  assertPlatform,
  enableModule,
  ensurePlatformDatabase,
  lookupModuleVersion,
  migratePlatform,
  type EnableGate,
  type LifecycleDeps,
  type LifecycleModule,
} from '@gremion/tenant-store/lifecycle'
import { loadCatalogueRows, type CatalogueModule, type CatalogueRowsResult } from './catalogue-rows.ts'
import { assertUuid, ProvisioningError } from './errors.ts'
import { INTERIM_GATE_BASIS } from './operator-gate.ts'
import type { AttestationPort, CustomerRef, ModulesPort } from './ports.ts'

export function pgAttestations(platform: Sql): AttestationPort {
  return {
    async lookup(customerId, moduleKey) {
      assertUuid(customerId, 'customer id')
      const rows = await platform<{ id: string }[]>`
        SELECT attestation_id::text AS id FROM plt.operator_enable_attestation
         WHERE customer_id = ${customerId} AND module_key = ${moduleKey}`
      return rows[0]?.id ?? null
    },
    async ensure(customerId, moduleKey, operatorId, enableList) {
      assertUuid(customerId, 'customer id')
      assertUuid(operatorId, 'operator id')
      await platform`
        INSERT INTO plt.operator_enable_attestation (customer_id, module_key, operator_id, enable_list, basis)
        VALUES (${customerId}, ${moduleKey}, ${operatorId}, ${[...enableList]}, ${INTERIM_GATE_BASIS})
        ON CONFLICT (customer_id, module_key) DO NOTHING`
      const id = await this.lookup(customerId, moduleKey)
      if (!id) throw new ProvisioningError('POSTCONDITION', `no attestation for (${customerId}, ${moduleKey}) after insert`)
      return id
    },
    async list(customerId) {
      assertUuid(customerId, 'customer id')
      const rows = await platform<{ module_key: string; id: string; operator_id: string; created_at: Date }[]>`
        SELECT module_key, attestation_id::text AS id, operator_id::text, created_at
          FROM plt.operator_enable_attestation WHERE customer_id = ${customerId} ORDER BY module_key`
      return rows.map((r) => ({ moduleKey: r.module_key, attestationId: r.id, operatorId: r.operator_id, createdAt: r.created_at }))
    },
  }
}

/**
 * The modules port over @gremion/tenant-store's enableModule. `lifecycle`
 * carries everything but the gate (platform, servers, secrets, exporter,
 * exportDir); the gate is the interim operator gate, passed per call.
 */
export function pgModules(opts: { platform: Sql; catalogue: readonly LifecycleModule[]; lifecycle: Omit<LifecycleDeps, 'enableGate' | 'platform'> }): ModulesPort {
  const byId = new Map(opts.catalogue.map((m) => [m.id, m]))
  return {
    catalogueIds: () => [...byId.keys()].sort(),
    async unloaded(ids) {
      const missing: string[] = []
      for (const id of ids) {
        const module = byId.get(id)
        // an id outside the catalogue is MODULE_UNKNOWN's (assertEnableList), not this check's
        if (!module) continue
        if (!(await lookupModuleVersion(opts.platform, id, module.moduleJson.runtime.version))) missing.push(id)
      }
      return missing
    },
    async enable(c: CustomerRef, moduleId: string, gate: EnableGate, operatorId: string) {
      const module = byId.get(moduleId)
      if (!module) throw new ProvisioningError('MODULE_UNKNOWN', `module ${moduleId} is not in the catalogue`)
      const r = await enableModule(c.id, module, { kind: 'operator', id: operatorId }, { ...opts.lifecycle, platform: opts.platform, enableGate: gate })
      return { noop: r.noop, database: r.database }
    },
    async enabled(c: CustomerRef) {
      const rows = await opts.platform<{ module_key: string }[]>`
        SELECT m.module_key FROM plt.module_enablement e JOIN plt.module m USING (module_id)
         WHERE e.customer_id = ${c.id} AND e.state = 'enabled' ORDER BY 1`
      return rows.map((r) => r.module_key)
    },
  }
}

export interface BootstrapDeps {
  /** The kernel server's POSTGRES_USER on its maintenance database. */
  kernelAdmin: Sql
  /** Opens gremion_platform AS its owner (a direct pool of >= 2). */
  openPlatform(): Sql
  owner: string
  ownerPassword: string
  catalogue: readonly CatalogueModule[]
  /** The ops realm (Q5); omitted for a database-only bootstrap. */
  opsRealm?: { ensure(): Promise<{ created: boolean }> }
  log?: (line: string) => void
}

export interface BootstrapResult {
  platformCreated: boolean
  applied: string[]
  catalogue: CatalogueRowsResult
  opsRealm: { created: boolean } | null
}

/**
 * `gremion-tenant init` (Q15): gremion_platform created if absent, migrated
 * (migratePlatform asserts the connection), the catalogue rows loaded (Q20),
 * the ops realm made (Q5). Idempotent: a rerun creates, applies and inserts
 * nothing.
 */
export async function bootstrapPlatform(deps: BootstrapDeps): Promise<BootstrapResult> {
  const log = deps.log ?? (() => {})
  const db = await ensurePlatformDatabase(deps.kernelAdmin, { owner: deps.owner, ownerPassword: deps.ownerPassword })
  log(`gremion_platform ${db.created ? 'created' : 'present'} (owner ${db.owner})`)
  const platform = deps.openPlatform()
  try {
    await assertPlatform(platform)
    const m = await migratePlatform(platform, { log })
    const catalogue = await loadCatalogueRows(platform, deps.catalogue)
    for (const u of catalogue.undecided) log(`catalogue: ${u.moduleKey} NOT loaded: ${u.reason}`)
    const opsRealm = deps.opsRealm ? await deps.opsRealm.ensure() : null
    return { platformCreated: db.created, applied: m.applied, catalogue, opsRealm }
  } finally {
    await platform.end({ timeout: 5 })
  }
}
