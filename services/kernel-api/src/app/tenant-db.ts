// services/kernel-api/src/app/tenant-db.ts -- the app-role pool of a customer's
// kernel database (TASK-080-a), through tenant-store like the schema gate:
//   * the target is the customer's OWN control row (kernelTargetResolver:
//     db_conn_ref -> secret -> a url that must name t_<hex32>__kernel), never the
//     environment;
//   * a changed db_conn_ref is picked up on the very next call (the old pool is
//     retired), and a pool the caller reports broken can be evicted (evict());
//   * prepare off: the runtime url may sit behind PgBouncer in transaction mode.
import type { DbProfile, Sql } from '@gremion/db'
import { createTenantStore } from '@gremion/tenant-store'
import { KERNEL_MODULE } from '../migrate/chain.ts'
import { kernelTargetResolver } from '../tenancy/target.ts'
import type { Logger, TenantDb, TenantRow } from './deps.ts'

export interface TenantDbOptions {
  resolveSecret(ref: string): string
  log: Logger
  maxPools?: number
  /** Connections per customer pool. Default 4. */
  maxConnections?: number
  /** Test seam (tenant-store createTenantStore's). */
  createDb?: (profile: DbProfile) => Sql
  evictGraceMs?: number
}

export function createTenantDb(o: TenantDbOptions): TenantDb & { evict(customerId: string): void; close(): Promise<void> } {
  const refs = new Map<string, string>()
  const poolRef = new Map<string, string>()
  const store = createTenantStore({
    resolveTarget: kernelTargetResolver({ refOf: (id) => refs.get(id), resolveSecret: (ref) => o.resolveSecret(ref) }),
    maxPools: o.maxPools ?? 64,
    maxConnections: o.maxConnections ?? 4,
    ...(o.evictGraceMs !== undefined ? { evictGraceMs: o.evictGraceMs } : {}),
    prepare: false,
    ...(o.createDb ? { createDb: o.createDb } : {}),
    onError: (err, context) => o.log.error('kernel-api: tenant db pool', { context, err: (err as Error).message }),
  })
  const evict = (customerId: string): void => {
    poolRef.delete(customerId)
    store.evictTenantDb(customerId, KERNEL_MODULE)
  }
  return {
    async sqlFor(tenant: TenantRow): Promise<Sql> {
      const id = tenant.customerId
      const had = poolRef.get(id)
      if (had !== undefined && had !== tenant.dbConnRef) evict(id)
      refs.set(id, tenant.dbConnRef)
      poolRef.set(id, tenant.dbConnRef)
      return store.openTenantDb(id, KERNEL_MODULE)
    },
    evict,
    close: () => store.close(),
  }
}
