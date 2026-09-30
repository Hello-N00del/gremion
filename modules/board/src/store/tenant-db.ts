// modules/board/src/store/tenant-db.ts
//
// The board leaf's per-(tenant, board) store (R29-BOARD-STORE-K §3.2, D13): a
// request's database is t_<tenant uuid as 32 hex>__board, opened ONLY through
// @gremion/tenant-store (openTenantDb) behind ONE schema gate. Keyed on the
// tenant id alone — never the slug — so no header can move a request to
// another tenant's database.
//
// Fail closed:
//   gate ok                           -> the tenant's pool
//   gate behind | diverged            -> 503 schema_not_current (Retry-After): the
//                                        leaf never migrates (B21); enableModule does
//   gate unavailable -> classify:     SELECT 1 on the tenant pool
//     SQLSTATE 3D000 (no database)    -> 404 tenant_not_provisioned (never cached: the
//                                        gate caches no failed check; no database is
//                                        created, no shared database is fallen back to)
//     anything else                   -> 503 tenant_unavailable (Retry-After)
//
// The gate and the store are injected (built once, in src/app.ts); this file
// resolves no path and opens no connection of its own.
import type { SchemaGate, TenantStore } from '@gremion/tenant-store'
import type { Sql } from './index.js'

export const MODULE_ID = 'board'

/** A tenant-level refusal: the route answers it instead of running. */
export interface Refusal {
  readonly status: 404 | 503
  readonly code: 'tenant_not_provisioned' | 'schema_not_current' | 'tenant_unavailable'
  /** Seconds, for a 503. */
  readonly retryAfter?: number
}

export const NOT_PROVISIONED: Refusal = Object.freeze({ status: 404, code: 'tenant_not_provisioned' })

export function isRefusal(value: unknown): value is Refusal {
  return typeof value === 'object' && value !== null && 'status' in value && 'code' in value
}

/** The SQLSTATE of a postgres-js error, if any. */
export function sqlState(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

export interface BoardTenantDb {
  /** The tenant's pool, or why the request is refused. */
  resolve(tenantId: string): Promise<Sql | Refusal>
  /** Why the tenant's database cannot be used right now: 404 when it does not exist, else 503. */
  classify(tenantId: string): Promise<Refusal>
}

export function createBoardTenantDb({
  store,
  gate,
  retryAfterSeconds = 30,
}: {
  store: TenantStore
  gate: SchemaGate
  retryAfterSeconds?: number
}): BoardTenantDb {
  const unavailable: Refusal = Object.freeze({ status: 503, code: 'tenant_unavailable', retryAfter: retryAfterSeconds })

  async function classify(tenantId: string): Promise<Refusal> {
    try {
      const sql = await store.openTenantDb(tenantId, MODULE_ID)
      await sql`SELECT 1`
      return unavailable
    } catch (err) {
      return sqlState(err) === '3D000' ? NOT_PROVISIONED : unavailable
    }
  }

  return {
    classify,
    async resolve(tenantId) {
      const verdict = await gate.check(tenantId)
      if (verdict.ok) return store.openTenantDb(tenantId, MODULE_ID)
      if (verdict.reason === 'unavailable') return classify(tenantId)
      return { status: 503, code: 'schema_not_current', retryAfter: verdict.retryAfterSeconds }
    },
  }
}
