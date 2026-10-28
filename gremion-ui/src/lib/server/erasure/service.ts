// TRD-196 — the wired erasure service the admin API calls: real hooks, the
// current tenant's enabled modules and DB, and the tenant-DB report store.
import { readConfig } from '$lib/server/config'
import { getDb } from '$lib/server/db'
import { MODULE_MANIFESTS } from '$lib/modules/registry'
import { currentTenantId } from '$lib/server/tenant/context'
import { getErasureHook } from '$lib/server/modules/runtime-registry'
import { KERNEL_MODULE_ID, kernelErasureHook } from './kernel-hook'
import { IDENTITY_MODULE_ID, createIdentityErasureHook } from './identity-hook'
import { runErasure, subjectRef, type ErasureDeps, type ErasureReport } from './orchestrator'
import { createPgReportStore, getErasureReport, listErasureReports } from './report-store'

/**
 * The ENABLED module ids of the current tenant, the kernel's own step first and
 * the external-identity step second (its remove-ops are queued by the kernel step).
 * Non-toggleable manifests (core, governance) are answered by the kernel step, so
 * they are not listed twice; every other config-enabled id counts, including one no
 * manifest knows (it will report "no erasure hook", never be dropped).
 */
export function enabledModuleIds(modules: Record<string, boolean> = readConfig().modules): string[] {
  const alwaysOn = new Set(MODULE_MANIFESTS.filter((m) => !m.toggleable).map((m) => m.id))
  const ids = new Set<string>([KERNEL_MODULE_ID, IDENTITY_MODULE_ID])
  for (const [id, on] of Object.entries(modules)) if (on && !alwaysOn.has(id)) ids.add(id)
  return [...ids]
}

/**
 * Kernel-applied migrations (migration-ownership.ts CROSS_CUTTING_MIGRATIONS)
 * -> the module whose data table they create. Those tables exist (and may hold
 * the subject) even while the module is OFF; service.test pins the key set.
 */
export const CROSS_CUTTING_MIGRATION_OWNER: Readonly<Record<string, string>> = {
  '0003_calendar_schema.sql': 'calendar',
  '0004_committee_elections.sql': 'elections',
  '0034_deck_board.sql': 'board',
}

type ManifestLike = { id: string; toggleable: boolean; migrations?: readonly string[] }

/**
 * MED-3: the modules an erasure must cover = the ENABLED ones (enabledModuleIds)
 * plus every toggleable module that is OFF now but still holds data, i.e. one of
 * its migrations (own `migrations`, or a kernel-applied cross-cutting file it
 * owns) is in schema_migrations. ON->OFF is RETAIN (module-migrations.ts): the
 * tables and the subject's rows stay, so a disabled module is not "nothing to do".
 */
export function erasureModuleIds(
  modules: Record<string, boolean>,
  applied: ReadonlySet<string>,
  manifests: readonly ManifestLike[] = MODULE_MANIFESTS,
): string[] {
  const ids = new Set(enabledModuleIds(modules))
  for (const m of manifests) {
    if (!m.toggleable || ids.has(m.id)) continue
    const own = (m.migrations ?? []).map((b) => `${b}.sql`)
    const cross = Object.entries(CROSS_CUTTING_MIGRATION_OWNER).filter(([, o]) => o === m.id).map(([f]) => f)
    if ([...own, ...cross].some((f) => applied.has(f))) ids.add(m.id)
  }
  return [...ids]
}

async function appliedMigrations(): Promise<Set<string>> {
  const rows = await getDb()<{ filename: string }[]>`SELECT filename FROM schema_migrations`
  return new Set(rows.map((r) => r.filename))
}

// The identity step runs the reconcile worker's existing drain synchronously
// (tenant-scoped by the request's ALS, unit-locked, idempotent); lazy so the
// worker's cron import is not loaded by every importer of this service.
const identityErasureHook = createIdentityErasureHook({
  drain: async () => {
    const { drainDueMemberOps } = await import('$lib/server/governance/provisioning/worker')
    await drainDueMemberOps()
  },
})

export function defaultErasureDeps(): ErasureDeps {
  return {
    enabledModuleIds: async () => erasureModuleIds(readConfig().modules, await appliedMigrations()),
    hookFor: (id) =>
      id === KERNEL_MODULE_ID ? kernelErasureHook : id === IDENTITY_MODULE_ID ? identityErasureHook : getErasureHook(id),
    // In-process modules share the tenant pool; a module whose data lives in its own
    // service database reports that itself (its hook returns `skipped`).
    connectionFor: () => {
      try {
        return getDb()
      } catch {
        return null
      }
    },
    store: createPgReportStore(getDb()),
    now: () => new Date(),
  }
}

export function startErasure(
  input: { subjectId: string; requestedBy: string },
  deps: ErasureDeps = defaultErasureDeps(),
): Promise<ErasureReport> {
  return runErasure({ tenantId: currentTenantId(), ...input }, deps)
}

export function readErasureReport(id: string): Promise<ErasureReport | null> {
  return getErasureReport(getDb(), currentTenantId(), id)
}

export function readErasureReports(opts: { subjectId?: string } = {}): Promise<ErasureReport[]> {
  const tenantId = currentTenantId()
  return listErasureReports(getDb(), tenantId, {
    subjectRef: opts.subjectId ? subjectRef(tenantId, opts.subjectId) : undefined,
  })
}
