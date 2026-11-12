// src/lib/server/tenant/instance-state.ts
//
// #264 (HANDOVER-v8 Part C): map the REAL per-tenant boot readiness onto the client
// presentation contract ($lib/instance-status). CHEAP, in-memory readiness only
// (no DB): the shell layout calls it on every navigation to feed the topbar
// convergence badge + dashboard banner, so it must never issue a query or throw.
//
// E3: the full "ledger overlay" for the Systemstatus page was removed. The page
// shows live probe results (src/routes/systemstatus/probes.server.ts); the
// provisioning ledger records history, and a hand-wired tenant never updates it.
import type { TenantContext } from './context'
import { getTenantReadiness, type TenantReadiness } from './readiness'
import type { InstanceState } from '$lib/instance-status'

/** Per-tenant boot readiness → the overall instance state. */
export function readinessToInstanceState(r: TenantReadiness): InstanceState {
  switch (r) {
    case 'ready':
      return 'ready'
    case 'failed':
      return 'failed'
    case 'pending':
      return 'provisioning'
  }
}

/**
 * CHEAP overall state for the shell badge/banner — in-memory readiness only, no
 * DB read. Fail-safe to 'ready' (a status glitch must never block or noise-up the
 * shell). Every active tenant is migrated at boot (or lazily on first request)
 * → 'ready', so the badge/banner stay hidden in the normal case.
 */
export function instanceStateForTenant(
  tenant: Pick<TenantContext, 'id'> | null | undefined,
): InstanceState {
  if (!tenant) return 'ready'
  try {
    return readinessToInstanceState(getTenantReadiness(tenant.id))
  } catch {
    return 'ready'
  }
}
