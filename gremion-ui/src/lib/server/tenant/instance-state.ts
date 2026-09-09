// src/lib/server/tenant/instance-state.ts
//
// #264 (HANDOVER-v8 Part C): map the REAL backend convergence state onto the
// client presentation contract ($lib/instance-status). Two entry points:
//   • instanceStateForTenant  — CHEAP, in-memory readiness only (no DB). The
//     shell layout calls it on every navigation to feed the topbar convergence
//     badge + dashboard banner, so it must never issue a query or throw.
//   • instanceStatusDetail    — FULL, reads the per-silo provisioning ledger
//     (tenant_provisioning_resource) for the it-admin Systemstatus page.
//
// No NEW state machine: tenant.status + per-tenant readiness + the ledger are the
// existing sources (migrations-control/001, readiness.ts). The shared-plane
// services (app/registry) have no ledger row — they are always-on by construction
// and fall through to the snapshot's `ok`.
import type { TenantContext } from './context'
import { getTenantReadiness, type TenantReadiness } from './readiness'
import { getTenantResources, type ResourceStatus } from './registry'
import {
  type InstanceState,
  type ServiceStatus,
  SILO_SUBSYSTEM_TO_SERVICE,
  overallFromSilo,
} from '$lib/instance-status'

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

const RESOURCE_TO_SERVICE_STATUS: Record<ResourceStatus, ServiceStatus> = {
  ok: 'ok',
  pending: 'provisioning',
  failed: 'failed',
}

/**
 * CHEAP overall state for the shell badge/banner — in-memory readiness only, no
 * DB read. Fail-safe to 'ready' (a status glitch must never block or noise-up the
 * shell). The DEFAULT tenant is migrated at boot → 'ready', so the badge/banner
 * stay hidden in the normal case.
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

export interface InstanceStatusDetail {
  state: InstanceState
  /** Real per-service ledger statuses (service-key → status); empty when the
   *  tenant has no ledger rows (the snapshot for `state` then applies). */
  realStatuses: Partial<Record<string, ServiceStatus>>
}

/**
 * FULL status for the it-admin Systemstatus page: overlay the real per-silo
 * ledger (tenant_provisioning_resource) onto the snapshot and derive the overall
 * state from it when the ledger is complete. Falls back to the readiness-derived
 * state (no overrides → the snapshot renders) when the tenant has no/partial
 * ledger rows (e.g. the originator default tenant, which has none). Fail-safe.
 */
export async function instanceStatusDetail(
  tenant: Pick<TenantContext, 'id'>,
): Promise<InstanceStatusDetail> {
  const readinessState = instanceStateForTenant(tenant)
  try {
    const resources = await getTenantResources(tenant.id)
    if (resources.length === 0) {
      return { state: readinessState, realStatuses: {} }
    }
    const realStatuses: Record<string, ServiceStatus> = {}
    const silo: Record<string, ServiceStatus> = {}
    for (const r of resources) {
      const svc = SILO_SUBSYSTEM_TO_SERVICE[r.subsystem]
      if (!svc) continue
      const st = RESOURCE_TO_SERVICE_STATUS[r.status]
      realStatuses[svc] = st
      silo[svc] = st
    }
    // Derive the overall state from the real silo statuses only when the ledger
    // is complete (all four silo rows present); otherwise the picture is partial,
    // so trust the readiness-derived state.
    const siloComplete =
      Object.keys(silo).length === Object.keys(SILO_SUBSYSTEM_TO_SERVICE).length
    const state = siloComplete ? overallFromSilo(silo) : readinessState
    return { state, realStatuses }
  } catch {
    return { state: readinessState, realStatuses: {} }
  }
}
