// packages/provisioning/src/catalogue-rows.ts — the plt.module /
// plt.module_version rows `gremion-tenant init` loads (TASK-043 Q20; a named
// deviation: TASK-077's registry owns this load and adopts these rows).
//
// enableModule refuses MODULE_VERSION_UNKNOWN until the catalogue row exists,
// and no production code wrote one before this. One plt.module and one
// plt.module_version per catalogue entry, status `draft`, created and updated
// by `system`, ON CONFLICT DO NOTHING (the harness seedCatalogue's shape), so
// a rerun inserts nothing.
//
// No invented values: retention_profile_default_id is the module's own
// runtime.export.retentionProfile, and owning_context_code is that profile's
// context segment (rp-<ctx>-...), which must be one of SCHEMA's context codes.
// A module that declares no export profile is NOT loaded; it is reported as
// needing a decision (Q20's stop-and-ask per module), and an enable of it then
// fails MODULE_VERSION_UNKNOWN, loudly.
import type { Sql } from '@gremion/db'

/** SCHEMA plt.module module_owning_context_code_check. */
export const OWNING_CONTEXT_CODES: ReadonlySet<string> = new Set([
  'tnt', 'idt', 'oac', 'gov', 'brd', 'cal', 'fil', 'msg', 'hnd', 'pwd', 'pub', 'nws', 'mail', 'ntf', 'plt', 'ops', 'fin', 'ele',
])

const MODULE_KEY = /^[a-z][a-z_]{1,39}$/
const RETENTION = /^rp-([a-z]+)-[a-z0-9-]+$/
/** module_version_semver_check, restated (0002_plt_module.sql). */
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]{1,40})?$/

export interface CatalogueModule {
  id: string
  moduleJson: { runtime: { version: string; export: { retentionProfile: string } | null } }
}

export interface CatalogueRowPlan {
  load: { moduleKey: string; semver: string; retentionProfile: string; owningContext: string }[]
  undecided: { moduleKey: string; reason: string }[]
}

export function planCatalogueRows(modules: readonly CatalogueModule[]): CatalogueRowPlan {
  const plan: CatalogueRowPlan = { load: [], undecided: [] }
  for (const m of [...modules].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!MODULE_KEY.test(m.id)) {
      plan.undecided.push({ moduleKey: m.id, reason: `module id does not fit plt.module.module_key ${MODULE_KEY.source}` })
      continue
    }
    if (typeof m.moduleJson.runtime.version !== 'string' || !SEMVER.test(m.moduleJson.runtime.version)) {
      plan.undecided.push({ moduleKey: m.id, reason: `runtime.version ${JSON.stringify(m.moduleJson.runtime.version)} does not fit plt.module_version.semver (module_version_semver_check)` })
      continue
    }
    const rp = m.moduleJson.runtime.export?.retentionProfile
    if (!rp) {
      plan.undecided.push({ moduleKey: m.id, reason: 'module.json declares no runtime.export.retentionProfile: retention_profile_default_id needs an operator decision (Q20)' })
      continue
    }
    const ctx = RETENTION.exec(rp)?.[1]
    if (!ctx || !OWNING_CONTEXT_CODES.has(ctx)) {
      plan.undecided.push({ moduleKey: m.id, reason: `retention profile ${rp} names no SCHEMA context code: owning_context_code needs an operator decision (Q20)` })
      continue
    }
    plan.load.push({ moduleKey: m.id, semver: m.moduleJson.runtime.version, retentionProfile: rp, owningContext: ctx })
  }
  return plan
}

export interface CatalogueRowsResult extends CatalogueRowPlan {
  insertedModules: string[]
  insertedVersions: string[]
}

/** Upserts the plan into gremion_platform (asserted by the caller). */
export async function loadCatalogueRows(platform: Sql, modules: readonly CatalogueModule[]): Promise<CatalogueRowsResult> {
  const plan = planCatalogueRows(modules)
  const out: CatalogueRowsResult = { ...plan, insertedModules: [], insertedVersions: [] }
  for (const row of plan.load) {
    await platform.begin(async (tx) => {
      const m = await tx`
        INSERT INTO plt.module (module_key, name, owning_context_code, toggleable, created_by_kind, updated_by_kind)
        VALUES (${row.moduleKey}, ${row.moduleKey}, ${row.owningContext}, true, 'system', 'system')
        ON CONFLICT (module_key) DO NOTHING
        RETURNING 1`
      if (m.length) out.insertedModules.push(row.moduleKey)
      const v = await tx`
        INSERT INTO plt.module_version (module_id, semver, retention_profile_default_id, status, created_by_kind, updated_by_kind)
        SELECT module_id, ${row.semver}, ${row.retentionProfile}, 'draft', 'system', 'system' FROM plt.module WHERE module_key = ${row.moduleKey}
        ON CONFLICT (module_id, semver) DO NOTHING
        RETURNING 1`
      if (v.length) out.insertedVersions.push(row.moduleKey)
    })
  }
  return out
}
