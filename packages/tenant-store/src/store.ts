// packages/tenant-store/src/store.ts
//
// openTenantDb(tenant, module): the only way a service opens a tenant database
// (TRD-426; scripts/check-tenant-db-access.mjs enforces it). A bounded LRU of
// @gremion/db pools, keyed on the (tenant, module) PAIR — never the tenant
// alone, or tenant A's calendar pool would answer for tenant A's finance.
import { createDb as defaultCreateDb, type DbProfile, type Sql } from '@gremion/db'
import { assertModuleId, assertTargetMatches, assertTenantId, envResolveTarget, tenantModuleDbName, type ResolveTarget } from './names.js'

export interface TenantStoreOptions {
  /** Q2: injected; defaults to envResolveTarget(process.env). */
  resolveTarget?: ResolveTarget
  /** Pools kept open at once; the least recently used one is ended past it. Default 64. */
  maxPools?: number
  /** Per-pool size. Default 3 (the @gremion/db default tier). */
  maxConnections?: number
  /**
   * Prepared statements. Default false: a runtime pool may sit behind
   * PgBouncer in transaction mode (Q3). The migration runner never uses this
   * store; it connects directly.
   */
  prepare?: boolean
  /** Seconds an evicted pool gets to drain in-flight queries. Default 5. */
  drainSeconds?: number
  /** Test seam; defaults to @gremion/db createDb. */
  createDb?: (profile: DbProfile) => Sql
  /** Where an eviction's end() failure goes. Default console.error. */
  onError?: (err: unknown, context: string) => void
}

export interface TenantStore {
  openTenantDb(tenantId: string, moduleId: string): Promise<Sql>
  /** Open pools. */
  size(): number
  /** Ends every pool. */
  close(): Promise<void>
}

export function createTenantStore(options: TenantStoreOptions = {}): TenantStore {
  const resolveTarget = options.resolveTarget ?? envResolveTarget()
  const maxPools = options.maxPools ?? 64
  const maxConnections = options.maxConnections ?? 3
  const prepare = options.prepare ?? false
  const drainSeconds = options.drainSeconds ?? 5
  const createDb = options.createDb ?? defaultCreateDb
  const onError = options.onError ?? ((err, context) => console.error(`[tenant-store] ${context}:`, err))
  if (!Number.isInteger(maxPools) || maxPools < 1) throw new RangeError('maxPools must be a positive integer')

  // Insertion order is recency order: a hit is deleted and re-set at the end.
  const pools = new Map<string, Sql>()
  const opening = new Map<string, Promise<Sql>>()
  let closed = false

  function end(sql: Sql, context: string): Promise<void> {
    return sql.end({ timeout: drainSeconds }).catch((err: unknown) => onError(err, context))
  }

  async function open(key: string, tenantId: string, moduleId: string): Promise<Sql> {
    const dbName = tenantModuleDbName(tenantId, moduleId)
    const { url } = await resolveTarget(tenantId, moduleId)
    assertTargetMatches(url, dbName)
    // close() ran while the resolver was in flight: pool nothing.
    if (closed) throw new Error('tenant store is closed')
    const sql = createDb({ url, max: maxConnections, prepare })
    pools.set(key, sql)
    while (pools.size > maxPools) {
      const [oldKey, oldSql] = pools.entries().next().value as [string, Sql]
      pools.delete(oldKey)
      void end(oldSql, `evicting pool ${oldKey}`)
    }
    return sql
  }

  return {
    async openTenantDb(tenantId, moduleId) {
      // Validate before anything else sees the ids (the resolver included).
      assertTenantId(tenantId)
      assertModuleId(moduleId)
      if (closed) throw new Error('tenant store is closed')
      // '/' is outside both alphabets, so the key is injective on the pair.
      const key = `${tenantId}/${moduleId}`
      const hit = pools.get(key)
      if (hit) {
        pools.delete(key)
        pools.set(key, hit)
        return hit
      }
      const pending = opening.get(key)
      if (pending) return pending
      const p = open(key, tenantId, moduleId).finally(() => opening.delete(key))
      opening.set(key, p)
      return p
    },
    size: () => pools.size,
    async close() {
      closed = true
      const all = [...pools.entries()]
      pools.clear()
      await Promise.all(all.map(([key, sql]) => end(sql, `closing pool ${key}`)))
    },
  }
}

let defaultStore: TenantStore | undefined

/**
 * The process-wide store with the env resolver (GREMION_<MODULE>_PG_URL).
 * Services that need another resolver build their own with createTenantStore.
 */
export function openTenantDb(tenantId: string, moduleId: string): Promise<Sql> {
  defaultStore ??= createTenantStore()
  return defaultStore.openTenantDb(tenantId, moduleId)
}
