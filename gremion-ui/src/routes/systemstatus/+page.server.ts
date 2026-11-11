import type { PageServerLoad } from './$types'
import { readConfig } from '$lib/server/config'
import { getSetupHealthProbes } from '$lib/server/modules/runtime-registry'
import { probeServices, type ProbedService } from './probes.server'

// The route is it-admin-gated centrally (hooks.server.ts authGuard via
// PAGE_ACCESS.systemstatus = Role.ITAdmin). The load runs live probes against the
// services the app can reach (see ./probes.server.ts) and reads the module switches
// for the "Aktive Module" catalog. It reads no provisioning ledger: that records
// history, not whether a service answers now. Everything degrades to a safe
// default rather than throwing, because a status page must never 500.
export const load: PageServerLoad = async (event) => {
  const tenant = event.locals.tenant

  // null = config unreadable: the module switches are unknown, which is not "all off".
  let modules: Record<string, boolean> | null = null
  try {
    modules = readConfig().modules
  } catch (err) {
    console.warn(`[systemstatus] module config unreadable: ${err instanceof Error ? err.name : 'non-error'}`)
  }

  let services: ProbedService[] = []
  if (tenant) {
    let moduleProbes: ReturnType<typeof getSetupHealthProbes> = []
    try {
      moduleProbes = getSetupHealthProbes()
    } catch (err) {
      console.warn(`[systemstatus] module probe registry unavailable: ${err instanceof Error ? err.name : 'non-error'}`)
      moduleProbes = []
    }
    const kcBase = tenant.kcInternal.replace(/\/$/, '')
    services = await probeServices({
      db: () => tenant.db`SELECT 1`,
      keycloak: async () => {
        const res = await fetch(`${kcBase}/.well-known/openid-configuration`, { method: 'GET', signal: AbortSignal.timeout(3000) })
        if (!res.ok) {
          await res.body?.cancel()
          return false
        }
        const doc = (await res.json()) as { issuer?: string }
        return typeof doc.issuer === 'string' && doc.issuer.length > 0
      },
      modules,
      moduleProbes,
    })
  }

  // TASK-042: no tenant resolved means no realm, never a made-up 'default'. A
  // resolved tenant is active by construction (the resolver refuses any other
  // status), which is the only tenant-status signal this page needs.
  return { services, modules: modules ?? {}, realm: tenant?.slug ?? null, tenantActive: Boolean(tenant) }
}
