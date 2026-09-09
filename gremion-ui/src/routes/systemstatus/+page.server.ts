import type { PageServerLoad } from './$types'
import { instanceStatusDetail } from '$lib/server/tenant/instance-state'
import { readConfig } from '$lib/server/config'

// #264 (HANDOVER-v8 Part C). The route is it-admin-gated centrally
// (hooks.server.ts authGuard via PAGE_ACCESS.systemstatus = Role.ITAdmin), so the
// load only assembles the convergence view: the real per-silo ledger overlay +
// overall state (instanceStatusDetail) and the live module config for the
// "Aktive Module" catalog. Everything degrades to a safe default rather than
// throwing — a status page must never 500.
export const load: PageServerLoad = async (event) => {
  const tenant = event.locals.tenant
  const instance = tenant
    ? await instanceStatusDetail(tenant)
    : { state: 'ready' as const, realStatuses: {} }

  let modules: Record<string, boolean> = {}
  try {
    modules = readConfig().modules
  } catch {
    modules = {}
  }

  return { instance, modules, realm: tenant?.slug ?? 'default' }
}
