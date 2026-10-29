// services/kernel-api/src/bodies/core.ts -- what every domain operation shares.
//
// Rules every operation obeys (each is a test):
//   * ONE transaction per operation (inCustomerTx): the tenant GUC first, then
//     the rows, then the events -- all commit together or not at all;
//   * every aggregate event goes through enqueue(tx, ...) of @gremion/events,
//     built from the typed catalogue (src/outbox/catalogue.ts), so the outbox
//     row is the SAME transaction's, never a later one;
//   * the WriteAuthorizer is asked AFTER the target is loaded (so the body is
//     known) and BEFORE the first write; default deny (Q4);
//   * the database is the guard: CHECKs, the gist EXCLUDEs and the triggers
//     refuse what the model forbids; a refusal surfaces as BodiesError with the
//     constraint's name (mapPgError), never as a silent skip.
// No import from modules/** anywhere under src/bodies (M-OFF-2: the identity
// substrate depends on no deselectable module).
import type { Sql } from '@gremion/db'
import { enqueue } from '@gremion/events'
import { IDT_EVENTS, IDT_SOURCE, eventTypeOf, type IdtEventKey, type IdtPayload } from '../outbox/catalogue.ts'
import type { Actor, WriteAuthorizer } from './authz.ts'
import { BodiesError } from './errors.ts'
import { inCustomerTx } from './tx.ts'

export interface OpCtx {
  /** The customer's app-role pool (tenant-store). */
  sql: Sql
  /** The verified tenant of the request / the operator's --customer. */
  customerId: string
  actor: Actor
  traceparent?: string
}

export interface Written {
  rowVersion: number
}

export const one = <T>(rows: readonly (T | undefined)[], what: string): T => {
  const r = rows[0]
  if (r === undefined) throw new BodiesError('NOT_FOUND', what)
  return r
}

export const by = (a: Actor): { kind: string; id: string | null } => ({ kind: a.kind, id: a.id })

export function expectVersion(actual: number, expected: number | undefined, what: string): void {
  if (expected !== undefined && expected !== actual) throw new BodiesError('CONFLICT', `${what} is at version ${actual}, the write expected ${expected}`, 'row_version')
}

export interface Core {
  run<T>(ctx: OpCtx, fn: (tx: Sql) => Promise<T>): Promise<T>
  allow(ctx: OpCtx, operation: string, bodyId: string | null): Promise<void>
  emit<K extends IdtEventKey>(tx: Sql, ctx: OpCtx, key: K, version: number, id: string, payload: IdtPayload<K>): Promise<void>
  kindOf(tx: Sql, customerId: string, kindKey: string, level: 'body' | 'unit'): Promise<{ is_organ: boolean; can_hold_seats: boolean }>
  activeBody(tx: Sql, customerId: string, bodyId: string): Promise<void>
}

export function makeCore(authorizer: WriteAuthorizer): Core {
  return {
    run: (ctx, fn) => inCustomerTx(ctx.sql, ctx.customerId, fn),

    async allow(ctx, operation, bodyId) {
      if (!(await authorizer.authorize({ actor: ctx.actor, customerId: ctx.customerId, operation, bodyId }))) {
        throw new BodiesError('FORBIDDEN', `${operation} is not permitted for this caller`)
      }
    },

    async emit(tx, ctx, key, version, id, payload) {
      await enqueue(tx, {
        eventType: eventTypeOf(key),
        source: IDT_SOURCE,
        aggregate: { type: IDT_EVENTS[key].aggregate, id, version },
        data: payload as Record<string, unknown>,
        ...(ctx.traceparent ? { traceparent: ctx.traceparent } : {}),
      })
    },

    /** Q8: a kind the customer's catalogue does not hold (or retired, or of the other level) refuses. */
    async kindOf(tx, customerId, kindKey, level) {
      const [k] = await tx<{ is_organ: boolean; can_hold_seats: boolean }[]>`
        SELECT is_organ, can_hold_seats FROM idt.org_unit_kind WHERE customer_id = ${customerId}::uuid AND kind_key = ${kindKey} AND level = ${level} AND state = 'active'`
      if (!k) throw new BodiesError('UNMAPPED_KIND', `kind ${JSON.stringify(kindKey)} is not an active ${level} kind of this customer's catalogue`)
      return k
    },

    async activeBody(tx, customerId, bodyId) {
      const [b] = await tx<{ state: string }[]>`SELECT state FROM idt.body WHERE customer_id = ${customerId}::uuid AND body_id = ${bodyId}::uuid FOR SHARE`
      if (!b) throw new BodiesError('NOT_FOUND', `body ${bodyId}`)
      if (b.state !== 'active') throw new BodiesError('INVALID', `body ${bodyId} is archived`)
    },
  }
}
