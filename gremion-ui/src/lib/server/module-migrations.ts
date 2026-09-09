// Module-aware migration gating (Pillar-1 P0.2; Pillar-3 #203 WP5). PURE — no
// DB/IO, so it unit-tests without Postgres. A disabled toggleable module's
// migrations are filtered out of the apply set on a FRESH init (recorded
// nowhere — "absence, not bookkeeping"). On an already-initialized DB, a true
// OFF→ON re-enable now has its module's migrations PLANNED for catch-up by
// moduleReenableCatchup (which replaced the previous throwing re-enable guard):
// replaying the module's migrations against the advanced schema is supported.
// ON→OFF is RETAIN — nothing is planned (no drop, no schema_migrations removal).
import type { ModuleManifest } from '$lib/modules/types'

type ModulesConfig = { modules: Record<string, boolean> }

function disabledToggleableModules(config: ModulesConfig, manifests: ModuleManifest[]): ModuleManifest[] {
  return manifests.filter((m) => m.toggleable && config.modules[m.id] === false)
}

/** A module's migration on-disk filenames (basename + .sql). */
function migrationFilesOf(m: ModuleManifest): string[] {
  return (m.migrations ?? []).map((b) => `${b}.sql`)
}

/** The set of migration FILES (basename + .sql) owned by disabled toggleable modules. */
export function disabledModuleMigrationFiles(config: ModulesConfig, manifests: ModuleManifest[]): Set<string> {
  const files = new Set<string>()
  for (const m of disabledToggleableModules(config, manifests)) {
    for (const f of migrationFilesOf(m)) files.add(f)
  }
  return files
}

/** A planned OFF→ON catch-up: a re-enabled module and the migration files
 *  (basename + .sql, filename order) to replay against the advanced schema. */
export interface ModuleReenableCatchup {
  moduleId: string
  files: string[]
}

/**
 * Plan the OFF→ON re-enable catch-up. PURE — returns an array and NEVER throws.
 * For each ENABLED toggleable module whose migrations are unapplied AND the DB
 * is NOT fresh (initialized earlier with the module OFF), return its migration
 * files (in filename order) to replay against the advanced schema. This
 * replaced the previous throwing re-enable guard — the OFF→ON catch-up is now
 * supported, not refused.
 *
 * Returns [] (nothing to catch up) for:
 *   - a fresh DB (isFreshDb): the normal forward apply loop handles it;
 *   - a disabled module: see disabledModuleMigrationFiles (skip + record nowhere) —
 *     this is also the ON→OFF RETAIN policy (no drop, no schema_migrations removal);
 *   - a fully-applied enabled module: nothing is unapplied;
 *   - an always-ON module with a newly-appended migration (appliedOfModule.length>0):
 *     a normal forward apply, NOT a re-enable catch-up.
 */
export function moduleReenableCatchup(args: {
  isFreshDb: boolean
  applied: Set<string>
  config: ModulesConfig
  manifests: ModuleManifest[]
}): ModuleReenableCatchup[] {
  if (args.isFreshDb) return []
  const plans: ModuleReenableCatchup[] = []
  for (const m of args.manifests) {
    if (!m.toggleable || args.config.modules[m.id] !== true) continue
    const files = migrationFilesOf(m)
    const appliedOfModule = files.filter((f) => args.applied.has(f))
    const unapplied = files.filter((f) => !args.applied.has(f))
    // Only a TRUE OFF->ON re-enable needs catch-up: the module ran OFF so its
    // schema was never created -> NONE of its migrations are applied on this
    // (non-fresh) DB. If SOME are applied, the module has always been ON and
    // this is a normal forward migration (a new file appended) -> the standard
    // apply loop handles it; plan no catch-up.
    if (unapplied.length > 0 && appliedOfModule.length === 0) {
      // migrationFilesOf preserves manifest order, which is filename order.
      plans.push({ moduleId: m.id, files })
    }
  }
  return plans
}
