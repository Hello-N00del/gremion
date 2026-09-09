// src/lib/server/tenant/conn-profile.ts
// P2.1b T11 — the conn_profile budget clamp, applied at registry-WRITE.
//
// getPoolForTenant sizes each tenant's pool from the registry row's
// `conn_profile.perTenantMax`, so one oversized row could overrun the pinned
// Postgres max_connections regardless of the asserted worst-case budget
// (pool-registry.test.ts). Bounding the value where it is PERSISTED keeps the
// invariant `POOL_REGISTRY_MAX × max(dbMax) + ADMIN_RESERVE ≤ MAX_CONNECTIONS`
// true for every row the resolver can ever read.
//
// Every conn_profile write MUST route through clampConnProfile —
// registerTenant today; any future conn_profile update path as well.
import { TENANT_DB_MAX_LIMIT } from '$lib/server/db/pool-registry'

/**
 * Validate/clamp `perTenantMax` in a conn_profile about to be persisted.
 *
 * - absent / null → returned untouched (the resolver defaults to
 *   DEFAULT_DB_MAX at read time; tenant #1 stays byte-identical).
 * - a positive integer ≤ TENANT_DB_MAX_LIMIT → returned untouched
 *   (same object identity — an in-budget write is a no-op).
 * - a positive integer > TENANT_DB_MAX_LIMIT → CLAMPED to the limit, with a
 *   loud warn naming the tenant (operator oversizing must not break
 *   provisioning, but it must never overrun the connection budget either).
 * - anything else (non-number, NaN/Infinity, non-integer, < 1) → throw:
 *   a malformed write is a bug; fail loud at write time instead of
 *   poisoning the registry.
 */
export function clampConnProfile(
  connProfile: Record<string, unknown>,
  slug: string,
): Record<string, unknown> {
  const raw = connProfile.perTenantMax
  if (raw === undefined || raw === null) return connProfile
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new Error(
      `invalid conn_profile.perTenantMax for tenant "${slug}": ${JSON.stringify(raw)} ` +
        `(expected a positive integer ≤ ${TENANT_DB_MAX_LIMIT})`,
    )
  }
  if (raw <= TENANT_DB_MAX_LIMIT) return connProfile
  console.warn(
    `[tenant-registry] conn_profile.perTenantMax=${raw} for tenant "${slug}" exceeds the ` +
      `per-tenant budget limit ${TENANT_DB_MAX_LIMIT} ` +
      `(POOL_REGISTRY_MAX × limit + ADMIN_RESERVE must fit the pinned max_connections) — ` +
      `clamped to ${TENANT_DB_MAX_LIMIT}`,
  )
  return { ...connProfile, perTenantMax: TENANT_DB_MAX_LIMIT }
}
