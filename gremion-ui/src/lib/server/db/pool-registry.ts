// gremion-ui/src/lib/server/db/pool-registry.ts
// P2.1a / D4: the bounded, DRAINING per-tenant pool registry. Replaces the two
// process-global `let _db` singletons with ONE LRU of postgres-js clients keyed
// by canonical registry tenant id. lru-cache's dispose is SYNCHRONOUS, so we
// fire-and-forget sql.end() (postgres-js drain returns a Promise) — the LRU
// cannot block on async eviction; a best-effort drain is correct. The drain
// promise MUST swallow its rejection (.catch): on Node 22 the default
// unhandledRejection mode is `throw`, so an un-caught end() rejection during
// eviction would crash the whole process.
import { LRUCache } from 'lru-cache'
import { createDb, type DbProfile, type Sql } from '@gremion/db'

/** The minimal tenant shape this module needs from TenantContext (§7.1). */
export interface PoolTenant {
  readonly id: string
  readonly dbUrl: string
  readonly dbMax: number
  readonly dbPrepare: boolean
}

/** Max live per-tenant pools. Connection budget cap = POOL_REGISTRY_MAX x dbMax. */
export const POOL_REGISTRY_MAX = 16

// ── Connection budget (P2.1a/D4) ───────────────────────────────────────────
// The per-instance Postgres `max_connections` must hold the worst case:
// every LRU slot full, each pool at its per-tenant `max`, plus a reserve for
// the control pool (max:3) + the KC-admin/out-of-band callers. These constants
// are asserted in pool-registry.test.ts so a future POOL_REGISTRY_MAX / dbMax
// bump that would overrun the DB is caught at unit-test time, not in prod.
/** The default per-tenant pool size (mirrors registry connProfile.perTenantMax default). */
export const DEFAULT_DB_MAX = 4
/** Headroom for the control pool + admin/migration/out-of-request connections. */
export const ADMIN_RESERVE = 16
/**
 * The provisioned per-instance Postgres max_connections this app sizes against.
 * P2.1b T11: pinned explicitly in the prod overlay (docker-compose.prod.yml
 * postgres `command: -c max_connections=100`) so the asserted budget reflects
 * runtime reality instead of relying on postgres:16-alpine's default (also
 * 100). NOTE: this instance is SHARED with Keycloak/Nextcloud/Helios + the
 * control pool, so the real app-side headroom is tighter than 100 — which is
 * why the prod overlay also fronts the app's data-plane connections with
 * PgBouncer (transaction mode; see docs/runbooks/pgbouncer.md).
 */
export const MAX_CONNECTIONS = 100

/**
 * P2.1b T11: the largest per-tenant pool size the registry will WRITE.
 * getPoolForTenant sizes each pool from the operator-controlled per-tenant
 * `dbMax` (NOT DEFAULT_DB_MAX), so the budget only holds if every persisted
 * conn_profile.perTenantMax is bounded — clampConnProfile
 * (lib/server/tenant/conn-profile.ts) enforces this limit at registry-write.
 * Derived so the TRUE worst case — every LRU slot live at the biggest
 * allowed pool — still fits with the admin reserve intact:
 *   POOL_REGISTRY_MAX × TENANT_DB_MAX_LIMIT + ADMIN_RESERVE ≤ MAX_CONNECTIONS.
 */
export const TENANT_DB_MAX_LIMIT = Math.floor((MAX_CONNECTIONS - ADMIN_RESERVE) / POOL_REGISTRY_MAX)

/**
 * #256-4 (P2.1b T8): how long a CAPACITY-evicted (LRU) pool keeps serving
 * in-flight queries before its deferred drain. Explicit eviction (tenant
 * suspend/delete via evictTenantRuntime, and test resets) drains immediately.
 * Deliberately matches the registry's RESOLUTION_CACHE_TTL_MS: a cached
 * TenantContext can hold its pool for at most the cache TTL, so the grace
 * period covers the whole window in which a stale context may still query.
 */
export const EVICTED_POOL_DRAIN_GRACE_MS = 30_000

let _registry: LRUCache<string, Sql> | null = null

function registry(): LRUCache<string, Sql> {
  if (!_registry) {
    _registry = new LRUCache<string, Sql>({
      max: POOL_REGISTRY_MAX,
      dispose: (sql, key, reason) => {
        if (reason === 'evict') {
          // #256-4: CAPACITY eviction — a burst of other tenants can push out
          // a pool whose owner still has queries (or a cached resolution
          // context) in flight. Defer the drain by a grace period instead of
          // yanking the connections, and log LOUDLY: recurring capacity
          // evictions mean POOL_REGISTRY_MAX is too low for the live fleet.
          console.warn(
            `[pool-registry] capacity eviction: tenant ${key}'s pool pushed out past ` +
              `POOL_REGISTRY_MAX=${POOL_REGISTRY_MAX} live pools — drain deferred by ` +
              `${EVICTED_POOL_DRAIN_GRACE_MS}ms so in-flight queries can finish`,
          )
          const timer = setTimeout(() => { sql.end().catch(() => {}) }, EVICTED_POOL_DRAIN_GRACE_MS)
          // Node returns a Timeout (unref keeps shutdown clean); jsdom/fake
          // timers return a number — hence the defensive optional call.
          ;(timer as unknown as { unref?: () => void }).unref?.()
        } else {
          // Explicit eviction (delete/clear/overwrite): immediate best-effort
          // drain — the tenant is being shut off, nothing deserves a grace.
          sql.end().catch(() => {})
        }
      },
    })
  }
  return _registry
}

export function getPoolForTenant(tenant: PoolTenant): Sql {
  const reg = registry()
  const existing = reg.get(tenant.id)
  if (existing) return existing
  const profile: DbProfile = { url: tenant.dbUrl, max: tenant.dbMax, prepare: tenant.dbPrepare }
  const sql = createDb(profile)
  reg.set(tenant.id, sql)
  return sql
}

/** Drain + drop one tenant's pool (tenant suspend/delete, P2.1c). */
export function evictTenantPool(tenantId: string): void {
  registry().delete(tenantId)
}

/** Test-only: drain every pool and reset the registry. */
export function _resetPoolRegistryForTests(): void {
  _registry?.clear()
  _registry = null
}
