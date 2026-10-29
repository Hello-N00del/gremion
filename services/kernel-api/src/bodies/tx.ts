// services/kernel-api/src/bodies/tx.ts -- one transaction per operation, the
// tenant context first. `gremion.customer_id` is set from the VERIFIED tenant
// of the request (never from input) with set_config(..., true): transaction
// local, so a pooled connection carries nothing over. Every idt table is
// FORCE ROW LEVEL SECURITY keyed on it.
import type { Sql } from '@gremion/db'
import { BodiesError, mapPgError } from './errors.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export async function inCustomerTx<T>(sql: Sql, customerId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  if (!UUID.test(customerId)) throw new BodiesError('INVALID', `${JSON.stringify(customerId)} is not a customer id`)
  try {
    return (await sql.begin(async (tx) => {
      await tx`SELECT set_config('gremion.customer_id', ${customerId}, true)`
      return fn(tx as unknown as Sql)
    })) as T
  } catch (err) {
    return mapPgError(err)
  }
}
