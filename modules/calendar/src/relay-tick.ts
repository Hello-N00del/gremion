// relay-tick.ts — one relay tick over the tenant fleet, with per-tenant isolation.
//
// BYTE-IDENTICAL in the calendar, content and newsletter leaves.
//
// The tick used to resolve every tenant's store inside one try block. A tenant
// whose store refuses (TenantIdentityMismatchError, a pool that cannot open, ...)
// threw out of the loop and the tenants listed AFTER it were never drained that
// tick: one bad tenant starved the rest of the fleet. Each tenant now has its own
// try/catch, so a refusal is logged (the tenant id and the error class only - the
// message of a refusal can carry the slug) and the loop moves on.
//
// A failure of listTenants() itself is NOT swallowed here: no tenant can be
// processed without the list, and the caller's tick-level handler logs it.

import type { TenantRef, Sql } from './tenant-store.js'

export interface RelayTickDeps {
  /** The active tenants to drain (production: the tenant catalog). */
  listTenants(): Promise<TenantRef[]>
  /** The tenant's own store (production: the injected storeFor). May throw per tenant. */
  storeFn(tenant: TenantRef): Promise<Sql>
  /** One relay pass for the tenant (production: runRelayPass on the broker). */
  pass(sql: Sql, tenant: TenantRef): Promise<unknown>
}

/** Drain every tenant's outbox once; one tenant's failure never skips the next. */
export async function runRelayTick(deps: RelayTickDeps): Promise<void> {
  const tenants = await deps.listTenants()
  for (const tenant of tenants) {
    try {
      const sql = await deps.storeFn(tenant)
      await deps.pass(sql, tenant)
    } catch (err) {
      console.warn(
        `[relay] tenant ${tenant.id} skipped this tick:`,
        err instanceof Error ? err.name : 'non-Error throw',
      )
    }
  }
}
