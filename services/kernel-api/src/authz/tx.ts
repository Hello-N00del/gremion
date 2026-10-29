// services/kernel-api/src/authz/tx.ts — the one transaction wrapper of the authz
// module: the customer's RLS context is the FIRST statement of every
// transaction (TRD-084), taken from the resolved request context, never from
// the request body. The Sql handle comes from tenant-store's target resolver
// (the module opens no connection of its own, TRD-426).
import type { Sql } from '@gremion/db'

export type { Sql }

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * assertUuid's refusal of a malformed identifier. A TypeError subclass (existing callers that test for TypeError keep working),
 * but the one callers that mean "bad input" match on: any OTHER TypeError is a bug or a driver fault, never an input refusal.
 */
export class AuthzInputError extends TypeError {
  override name = 'AuthzInputError'
}

export function assertUuid(v: unknown, what: string): asserts v is string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new AuthzInputError(`authz: ${what} is not a uuid`)
}

/** Runs `fn` in one transaction with gremion.customer_id = customerId (transaction-local). */
export async function inCustomerTx<T>(sql: Sql, customerId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  assertUuid(customerId, 'customerId')
  return (await sql.begin(async (tx) => {
    await tx`SELECT set_config('gremion.customer_id', ${customerId}, true)`
    return fn(tx as unknown as Sql)
  })) as T
}
