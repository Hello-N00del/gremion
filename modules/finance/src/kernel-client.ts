// services/finance/src/kernel-client.ts
//
// Thin HTTP client shape for a finance-leaf → kernel callback. NOTE (#369 slice
// 3): the createSubOrg saga was implemented CLIENT-ORCHESTRATED, not leaf-
// orchestrated. The 3 org_units RESTRICT FKs are omitted from the leaf schema
// (migrations/001_finance_init.sql) because org_units lives in the kernel DB, so
// a sub-org write pairs an org_units row with a finance_unit row — but the
// orchestration lives on the KERNEL side (gremion-ui/.../backend/service-client.ts
// writes org_units through its injected FinanceOrgUnitKernelPort, then calls the
// leaf's finance_unit endpoints, compensating on failure). That is the sanctioned
// finance→governance direction (boundary rule `no-governance-to-finance`), so the
// leaf never needs to call BACK into the kernel for the saga. This forward-looking
// client shape is therefore UNUSED by the slice-3 saga; it is retained (tree-shaken
// out of the runtime bundle — nothing in src/index.ts imports it) as a pinned
// contract in case a future capability needs a genuine leaf→kernel callback.

import type { TenantRef } from './tenant-store.js'

export interface KernelClientConfig {
  /** Base URL of the kernel (e.g. http://gremion-ui:3000). */
  baseUrl: string
  /** Shared secret for the kernel's internal endpoints. */
  secret: string
  /** The tenant this call is scoped to (forwarded as x-tenant-* headers). */
  tenant: TenantRef
  /** Optional correlation id forwarded as x-correlation-id. */
  correlationId?: string
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof globalThis.fetch
}

export interface KernelClient {
  /**
   * SLICE-3: create a governance org_unit via a kernel callback, returning its
   * UUID so the leaf can insert the paired finance_unit row in the same saga.
   * Not implemented in slice 2 (surface lock).
   */
  createOrgUnit(input: {
    parentOrgUnitId: string
    name: string
    kind: string
  }): Promise<{ orgUnitId: string }>
}

const SAGA_PENDING =
  '[finance-kernel-client] the createSubOrg saga (org_units write via kernel callback) ' +
  'is not implemented in #369 slice 2 — it lands in slice 3. See docs/runbooks/finance-cutover.md.'

export function createKernelClient(config: KernelClientConfig): KernelClient {
  // config is captured for the slice-3 implementation; referenced here so the
  // parameter is not flagged as unused under strict tsconfig.
  void config.baseUrl
  return {
    async createOrgUnit(): Promise<{ orgUnitId: string }> {
      throw new Error(SAGA_PENDING)
    },
  }
}
