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
    enabledModuleIds: () => enabledModuleIds(),
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
