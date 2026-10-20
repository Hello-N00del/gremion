// packages/events/src/relay.ts (@gremion/events)
//
// createRelay: ONE relay loop per service database (TASK-079 Q10, TRD-430).
//
// One pass = one transaction: tenant context from database_binding, the
// transaction-level advisory lock (ADVISORY_LOCKS.outboxRelay: a second relay
// finds it taken and does nothing), then the due `pending` rows, oldest first,
// FOR UPDATE SKIP LOCKED. Each row is published under ITS OWN event_id (the
// stable identity: a crash between the PubAck and the `published` mark
// republishes the same id, which the stream's Nats-Msg-Id window and the
// consumer's inbox both absorb) and then marked. A failure raises attempt_count
// and next_attempt_at (min(2^n s, 1 h)); past maxAttempts the row is
// `dead_lettered` and the gauge raises the alert (TRD-420).
//
// Per-aggregate order (Q10): a row is never selected while an EARLIER version
// of the same (aggregate_type, aggregate_id) is anything but `published`, so a
// backing-off or dead-lettered v2 holds v3 back, and the relay cannot overtake
// (the consumer drops a stale version for good).
import type { Sql } from '@gremion/db'
import { ADVISORY_LOCKS } from '@gremion/tenant-store'
import { RELAY_MAX_ATTEMPTS, relayBackoffMs } from './backoff.ts'
import { errorCode, inTenantTx } from './db.ts'
import type { OutboxRow } from './envelope.ts'
import { assertContext } from './plumbing.ts'
import { DEFAULT_PUBLISH_TIMEOUT_MS, publishRow, type Publisher } from './publish.ts'

/** Where an event goes: a map from event type, or a function of the row (Q7: injected per service). */
export type SubjectMap = Readonly<Record<string, string>> | ((row: OutboxRow) => string)

export interface RelayOptions {
  /** The service database handle (tenant-store's openTenantDb). */
  sql: Sql
  /** The service's context code (idt, gov, ...): the schema holding outbox. */
  ctx: string
  /** A JetStream client, or a function that opens one (a failure leaves every row untouched). */
  js: Publisher | (() => Promise<Publisher>)
  subjects: SubjectMap
  batchSize?: number
  maxAttempts?: number
  pollMs?: number
  publishTimeoutMs?: number
  /** Where a pass-level failure goes (default console.error). */
  onError?: (err: unknown, where: string) => void
  log?: (line: string) => void
  /** Test seams: a throw here aborts the pass like a crash (the transaction rolls back). */
  hooks?: { afterPubAck?(row: OutboxRow): void | Promise<void> }
}

export interface PassResult {
  /** False when another relay held the lock: nothing was read or published. */
  locked: boolean
  published: number
  failed: number
  deadLettered: number
}

export interface Relay {
  runOnce(): Promise<PassResult>
  start(): void
  stop(): Promise<void>
}

const DUE_SQL = (ctx: string) => `
  SELECT o.event_id, o.customer_id, o.event_type, o.source, o.subject, o.event_time, o.data, o.traceparent,
         o.aggregate_type, o.aggregate_id, o.aggregate_version, o.test_run_id, o.attempt_count
    FROM ${ctx}.outbox AS o
   WHERE o.relay_state = 'pending'
     AND o.next_attempt_at <= now()
     AND NOT EXISTS (SELECT 1 FROM ${ctx}.outbox AS p
                      WHERE p.aggregate_type = o.aggregate_type AND p.aggregate_id = o.aggregate_id
                        AND p.aggregate_version < o.aggregate_version AND p.relay_state <> 'published')
   ORDER BY o.event_time, o.event_id
   LIMIT $1
   FOR UPDATE OF o SKIP LOCKED`

/** Error names (nats-core) that are a fact about ONE row's publish: refused subject, invalid subject, payload too large. */
const ROW_SPECIFIC_NAMES = new Set(['PermissionViolationError', 'InvalidSubjectError', 'InvalidArgumentError'])

/**
 * True when the failure belongs to the row (no subject configured, permission denied, max payload):
 * only those burn an attempt. Everything else (PubAck timeout, closed/draining connection, 503 no
 * responders, anything unclassified) is the broker's or the connection's, and burns nothing.
 */
export function isRowSpecificError(err: unknown): boolean {
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null
  if (e?.code === 'no_subject') return true
  if (typeof e?.name === 'string' && ROW_SPECIFIC_NAMES.has(e.name)) return true
  return typeof e?.message === 'string' && /max_payload|permissions? violation/i.test(e.message)
}

export const TRANSPORT_BACKOFF_CAP_MS = 30_000

/** The pause after `failures` (1-based) consecutive transport-failed passes: 1 s doubling, capped at 30 s. */
export function transportBackoffMs(failures: number): number {
  return Math.min(2 ** Math.min(Math.max(failures, 1) - 1, 30) * 1000, TRANSPORT_BACKOFF_CAP_MS)
}

export function subjectOf(subjects: SubjectMap, row: OutboxRow): string {
  const s = typeof subjects === 'function' ? subjects(row) : subjects[row.event_type]
  if (!s) throw Object.assign(new Error(`no subject configured for event type ${row.event_type}`), { code: 'no_subject' })
  return s
}

export function createRelay(opts: RelayOptions): Relay {
  assertContext(opts.ctx)
  const { sql, ctx } = opts
  const batchSize = opts.batchSize ?? 50
  const maxAttempts = opts.maxAttempts ?? RELAY_MAX_ATTEMPTS
  const pollMs = opts.pollMs ?? 1_000
  const timeoutMs = opts.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS
  const onError = opts.onError ?? ((err, where) => console.error(`[events] relay ${ctx}: ${where}:`, err))
  const log = opts.log ?? ((l) => console.info(`[events] relay ${ctx}: ${l}`))
  const lock = ADVISORY_LOCKS.outboxRelay
  let resolved: Publisher | undefined
  let running = false
  let loop: Promise<void> | undefined
  let wake: (() => void) | undefined
  let transportFailures = 0

  async function publisher(): Promise<Publisher> {
    if (resolved) return resolved
    if (typeof opts.js !== 'function') return (resolved = opts.js)
    // A client function is called anew per pass until it succeeds; its client is kept.
    const fn = opts.js as () => Promise<Publisher>
    return (resolved = await fn())
  }

  async function runOnce(): Promise<PassResult> {
    // Pass-level failure (no connection, refused credentials): rows stay pending, untouched.
    const js = await publisher()
    let transportError: { err: unknown } | undefined
    const result = await inTenantTx(sql, ctx, async (tx) => {
      const [l] = await tx`SELECT pg_try_advisory_xact_lock(${lock.classid}::int, ${lock.objid}::int) AS ok`
      if (!l?.ok) return { locked: false, published: 0, failed: 0, deadLettered: 0 }
      const rows = await tx.unsafe<OutboxRow[] & { attempt_count: number }[]>(DUE_SQL(ctx), [batchSize])
      const res: PassResult = { locked: true, published: 0, failed: 0, deadLettered: 0 }
      let consecutiveFailures = 0
      for (const row of rows as unknown as (OutboxRow & { attempt_count: number })[]) {
        // A broker that is down would hold this transaction for batchSize x timeout: after three
        // failures in a row the rest of the batch is left untouched (no attempt burned) for the next pass.
        if (consecutiveFailures >= 3) break
        let acked = false
        try {
          await publishRow(js, subjectOf(opts.subjects, row), row, timeoutMs)
          acked = true
        } catch (err) {
          if (!isRowSpecificError(err)) {
            // A broker/connection fact, not the row's: nothing is counted; the rest of the batch is left
            // for the next pass (what was already published stays marked) and the caller backs off.
            transportError = { err }
            break
          }
          const attempt = row.attempt_count + 1
          const dead = attempt >= maxAttempts
          await tx.unsafe(
            `UPDATE ${ctx}.outbox
                SET attempt_count = $2,
                    last_error_code = $3,
                    relay_state = CASE WHEN $4::boolean THEN 'dead_lettered' ELSE 'pending' END,
                    dead_lettered_at = CASE WHEN $4::boolean THEN now() END,
                    next_attempt_at = CASE WHEN $4::boolean THEN next_attempt_at ELSE now() + make_interval(secs => $5::double precision) END
              WHERE event_id = $1`,
            [row.event_id, attempt, errorCode(err, 'publish_failed'), dead, relayBackoffMs(attempt) / 1000],
          )
          res.failed++
          consecutiveFailures++
          if (dead) {
            res.deadLettered++
            log(`event ${row.event_id} dead-lettered after ${attempt} attempts (${errorCode(err, 'publish_failed')})`)
          }
        }
        if (acked) {
          // A throw here is a crash between the PubAck and the mark: the pass rolls back and
          // the next pass republishes the SAME id.
          await opts.hooks?.afterPubAck?.(row)
          await tx.unsafe(`UPDATE ${ctx}.outbox SET relay_state = 'published', published_at = now(), last_error_code = NULL WHERE event_id = $1`, [row.event_id])
          res.published++
          consecutiveFailures = 0
        }
      }
      return res
    })
    if (transportError) throw transportError.err
    return result
  }

  return {
    runOnce,
    start() {
      if (running) return
      running = true
      loop = (async () => {
        while (running) {
          let busy = false
          try {
            busy = (await runOnce()).published > 0
            transportFailures = 0
          } catch (err) {
            onError(err, 'pass failed')
            transportFailures++
          }
          if (running && !busy) await new Promise<void>((r) => {
            const t = setTimeout(r, Math.max(pollMs, transportFailures > 0 ? transportBackoffMs(transportFailures) : 0))
            wake = () => {
              clearTimeout(t)
              r()
            }
          })
        }
      })()
    },
    async stop() {
      running = false
      wake?.()
      await loop
    },
  }
}
