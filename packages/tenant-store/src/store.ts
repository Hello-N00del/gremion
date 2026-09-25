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
  /**
   * An evicted pool is not ended at once — a caller may still hold it
   * mid-request — but after this grace, in ms. Default 30000.
   */
  evictGraceMs?: number
  /** Then: seconds end() gives in-flight queries. Default 5. */
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
  const evictGraceMs = options.evictGraceMs ?? 30_000
  const createDb = options.createDb ?? defaultCreateDb
  const onError = options.onError ?? ((err, context) => console.error(`[tenant-store] ${context}:`, err))
  for (const [name, v, min] of [['maxPools', maxPools, 1], ['maxConnections', maxConnections, 1], ['drainSeconds', drainSeconds, 0], ['evictGraceMs', evictGraceMs, 0]] as const) {
    if (!Number.isInteger(v) || v < min) throw new RangeError(`${name} must be an integer >= ${min}`)
  }

  // Insertion order is recency order: a hit is deleted and re-set at the end.
  const pools = new Map<string, Sql>()
  const opening = new Map<string, Promise<Sql>>()
  // Evicted pools waiting out their grace before end(), by key. Capped at
  // maxPools: past it the oldest is ended early, so open pools stay within
  // 2 x maxPools however fast pairs churn.
  const draining = new Map<string, { sql: Sql; timer: ReturnType<typeof setTimeout> }>()
  let closed = false

  function end(sql: Sql, context: string): Promise<void> {
    return sql.end({ timeout: drainSeconds }).catch((err: unknown) => onError(err, context))
  }

  function evictOverflow(): void {
    while (pools.size > maxPools) {
      const [oldKey, oldSql] = pools.entries().next().value as [string, Sql]
      pools.delete(oldKey)
      const timer = setTimeout(() => {
        draining.delete(oldKey)
        void end(oldSql, `evicting pool ${oldKey}`)
      }, evictGraceMs)
      timer.unref?.()
      draining.set(oldKey, { sql: oldSql, timer })
      while (draining.size > maxPools) {
        const [k, d] = draining.entries().next().value as [string, { sql: Sql; timer: ReturnType<typeof setTimeout> }]
        clearTimeout(d.timer)
        draining.delete(k)
        void end(d.sql, `evicting pool ${k} early (drain cap)`)
      }
    }
  }

  async function open(key: string, tenantId: string, moduleId: string): Promise<Sql> {
    const dbName = tenantModuleDbName(tenantId, moduleId)
    const { url } = await resolveTarget(tenantId, moduleId)
    assertTargetMatches(url, dbName)
    // close() ran while the resolver was in flight: pool nothing.
    if (closed) throw new Error('tenant store is closed')
    const sql = createDb({ url, max: maxConnections, prepare })
    pools.set(key, sql)
    evictOverflow()
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
      // Requested again during its grace: take the draining pool back rather
      // than open a second one beside it.
      const back = draining.get(key)
      if (back) {
        clearTimeout(back.timer)
        draining.delete(key)
        pools.set(key, back.sql)
        evictOverflow()
        return back.sql
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
      for (const [key, d] of draining) {
        clearTimeout(d.timer)
        all.push([`${key} (evicted)`, d.sql])
      }
      draining.clear()
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

export interface MigrationDbOptions {
  /** Defaults to envResolveTarget(process.env, 'direct'): GREMION_<MODULE>_PG_DIRECT_URL. */
  resolveTarget?: ResolveTarget
  /** Test seam; defaults to @gremion/db createDb. */
  createDb?: (profile: DbProfile) => Sql
}

/**
 * A DIRECT connection to one (tenant, module) database, for runMigrations
 * (Q3: never through a pooler; the runner re-checks). Two connections: the
 * runner reserves one and keeps the other to terminate the first if it ever
 * cannot release its lock. Not pooled or cached — the caller ends it.
 */
export async function openMigrationDb(tenantId: string, moduleId: string, options: MigrationDbOptions = {}): Promise<Sql> {
  const dbName = tenantModuleDbName(tenantId, moduleId)
  const resolveTarget = options.resolveTarget ?? envResolveTarget(process.env, 'direct')
  const { url } = await resolveTarget(tenantId, moduleId)
  assertTargetMatches(url, dbName)
  return (options.createDb ?? defaultCreateDb)({ url, max: 2, prepare: true })
}
