// packages/events/src/enqueue.ts (@gremion/events)
//
// enqueue(tx, event): the producer half of the transactional outbox (TRD-422).
// The row is inserted through the CALLER'S transaction handle, so it commits
// with the domain state change or not at all; a pool or a reserved connection
// (auto-commit) is refused. The tenant comes from the transaction's own
// `gremion.customer_id` (the RLS context every service sets first), the schema
// from the source (`/gremion/idt` -> idt.outbox), the id from the table's
// DEFAULT uuidv7() -- minted once, here, never at publish time.
import type { Sql } from '@gremion/db'
import { contextOfSource } from './envelope.ts'

export interface EnqueueInput {
  /** de.gremion.<ctx>.<entity>.<past-verb>.vN */
  eventType: string
  /** /gremion/<ctx>: names the schema whose outbox receives the row. */
  source: string
  subject?: string | null
  dataschema?: string | null
  aggregate: { type: string; id: string; version: number }
  /** Ids and minimal data only (TRD-154); `aggregate_version` is added to it. */
  data: Record<string, unknown>
  /** W3C Trace Context of the writing request. */
  traceparent?: string | null
  testRunId?: string | null
}

/** True for a postgres.js transaction (or savepoint) handle: only those carry `savepoint`. */
export function isTransaction(handle: unknown): boolean {
  return typeof handle === 'function' && typeof (handle as { savepoint?: unknown }).savepoint === 'function'
}

export class EnqueueError extends Error {
  override name = 'EnqueueError'
}

/** Inserts the outbox row in the caller's transaction and returns its event_id. */
export async function enqueue(tx: Sql, input: EnqueueInput): Promise<string> {
  if (!isTransaction(tx)) {
    throw new EnqueueError('[events] enqueue needs the handle of an open transaction (sql.begin); a pool or reserved connection would commit the event apart from the state change')
  }
  const ctx = contextOfSource(input.source)
  if (!ctx) throw new EnqueueError(`[events] source ${JSON.stringify(input.source)} is not /gremion/<ctx>`)
  const { type, id, version } = input.aggregate
  if (!Number.isSafeInteger(version) || version < 1) throw new EnqueueError(`[events] aggregate version must be a positive integer, got ${version}`)
  if ('aggregate_version' in input.data && Number(input.data.aggregate_version) !== version) {
    throw new EnqueueError('[events] data.aggregate_version disagrees with aggregate.version')
  }
  const data = { ...input.data, aggregate_version: version }
  const rows = await tx.unsafe<{ event_id: string }[]>(
    `INSERT INTO ${ctx}.outbox (customer_id, tenantid, event_type, source, subject, dataschema, data, traceparent, aggregate_type, aggregate_id, aggregate_version, test_run_id)
     SELECT c.id, c.id::text, $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10
       FROM (SELECT ${ctx}.current_customer_id() AS id) AS c
      WHERE c.id IS NOT NULL
     RETURNING event_id`,
    [input.eventType, input.source, input.subject ?? null, input.dataschema ?? null, JSON.stringify(data), input.traceparent ?? null, type, id, version, input.testRunId ?? null],
  )
  const row = rows[0]
  if (!row) throw new EnqueueError(`[events] gremion.customer_id is not set in this transaction: set it (SELECT set_config('gremion.customer_id', <customer>, true)) before enqueue`)
  return row.event_id
}
