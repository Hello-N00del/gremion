// packages/events/src/db.ts (@gremion/events)
//
// The library never opens a connection (TRD-426: tenant-store owns that, and
// scripts/check-tenant-db-access.mjs enforces it): every function takes an
// injected `Sql`. This file is the one place a transaction's tenant context is
// set, the way every service database does it: the first statement of the
// transaction takes the customer from database_binding (SCHEMA §0.6), which the
// FORCE ROW LEVEL SECURITY policies of the plumbing tables then match.
import type { Sql } from '@gremion/db'
import { assertContext } from './plumbing.ts'

export type { Sql }

/** A relay/consumer-side failure that is a fact about the database, not the event. */
export class BindingError extends Error {
  override name = 'BindingError'
}

/** Runs `fn` in one transaction whose gremion.customer_id is the database's bound customer. */
export async function inTenantTx<T>(sql: Sql, ctx: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  assertContext(ctx)
  return (await sql.begin(async (tx) => {
    const rows = await tx.unsafe<{ c: string }[]>(`SELECT set_config('gremion.customer_id', b.customer_id::text, true) AS c FROM ${ctx}.database_binding AS b`)
    if (rows.length !== 1) throw new BindingError(`[events] ${ctx}.database_binding holds ${rows.length} rows, want exactly 1`)
    return fn(tx as unknown as Sql)
  })) as T
}

/** A short, secret-free error code for last_error_code (1-64 characters). */
export function errorCode(err: unknown, fallback: string): string {
  const e = err as { code?: unknown; name?: unknown } | null
  const pick = typeof e?.code === 'string' && e.code ? e.code : typeof e?.name === 'string' && e.name && e.name !== 'Error' ? e.name : fallback
  const clean = pick.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64)
  return clean || fallback
}
