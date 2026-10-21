// packages/events/src/consumer.ts (@gremion/events)
//
// createConsumer: a DURABLE PULL consumer (AckExplicit, MaxDeliver, BackOff)
// that applies each event once (TRD-421) and dead-letters a poison message
// (TRD-420), per TASK-079 Q2-Q4, Q14.
//
// Per delivery, ONE transaction does: tenant context -> claim the inbox row on
// (Gremion-Source, eventId) -> test-run and stale-version checks -> the
// handler's effect -> the final inbox state; then COMMIT, then ack. The claim
// is part of the effect's transaction: a handler that throws rolls the claim
// back with the effect, so the next delivery applies (never a claim that
// outlives a failed effect). The failure is then recorded in its OWN
// transaction (`failed`, attempt_count + 1) and the message is nak'd with the
// BackOff delay. On the LAST delivery (MaxDeliver) the message is published to
// the tenant's DLQ stream (awaiting the PubAck; a `duplicate` ack is an error,
// the message stays for redelivery), the inbox row becomes `dead_lettered`, and
// the message is terminated. A crash on the last delivery is caught by the
// server's MAX_DELIVERIES advisory (captured into the same DLQ stream, G5) and
// by the stalled-inbox gauge.
//
// STRICT PER-AGGREGATE ORDER (operator decision 2026-10-21): the durable consumer has max_ack_pending 1, so
// while a message waits out its BackOff after a nak, NOTHING behind it is delivered: a later version of an
// aggregate is never applied while an earlier one is pending retry (so a redelivery is no longer
// skipped_stale because of a transient failure). The cost is head-of-line blocking: one poison message
// stalls its stream until MaxDeliver dead-letters it. skipped_stale remains for genuine late arrivals
// and for a DLQ replay after the aggregate moved on (Q14).
//
// The inbox key is taken from the headers and the body, NEVER from
// Nats-Msg-Id: a DLQ replay publishes under its own message id.
import type { Sql } from '@gremion/db'
import { AckPolicy, DeliverPolicy, JetStreamApiCodes, JetStreamApiError, type JetStreamClient, type JetStreamManager, type JsMsg } from '@nats-io/jetstream'
import { assertConsumerLimits, CONSUMER_BACKOFF_MS, CONSUMER_MAX_DELIVER, nakDelayMs } from './backoff.ts'
import { errorCode, inTenantTx } from './db.ts'
import { DLQ_HEADERS, H, parseEnvelope, type ParsedEvent } from './envelope.ts'
import { assertContext } from './plumbing.ts'
import { publishWire } from './publish.ts'

/** What a handler receives besides its transaction. */
export interface ConsumedEvent extends ParsedEvent {
  /** The NATS subject the message was published to. */
  subject: string
  deliveryCount: number
  streamSeq: number
}

/** The handler's effect: runs INSIDE the consumer's transaction (rolled back if it throws). */
export type EventHandler = (tx: Sql, event: ConsumedEvent) => Promise<void>

export type DeliveryOutcome = 'processed' | 'skipped_stale' | 'skipped_test' | 'duplicate' | 'retry' | 'dead_lettered' | 'envelope_invalid'

export interface ConsumerOptions {
  sql: Sql
  /** The consuming service's context code (the schema holding inbox). */
  ctx: string
  tenant: string
  /** The NATS identity's module (the DLQ subject is gremion.<tenant>.dlq.<module>.<name>). */
  module: string
  js: Pick<JetStreamClient, 'publish' | 'consumers'>
  /** Needed to create the durable consumer; omit when it already exists. */
  jsm?: Pick<JetStreamManager, 'consumers'>
  stream: string
  /** Durable consumer name. */
  name: string
  filterSubject?: string
  /** Where a NEW durable consumer starts: every stored message (default) or only those published after it exists. */
  startFrom?: 'all' | 'new'
  handler: EventHandler
  /** A consumer that reaches people records `skipped_test` for a test-run event (SCHEMA §0.6). */
  reachesPeople?: boolean
  maxDeliver?: number
  backoffMs?: readonly number[]
  publishTimeoutMs?: number
  onError?: (err: unknown, where: string) => void
  log?: (line: string) => void
  /** Test seams: a throw aborts processing like a crash (nothing is acked or terminated). */
  hooks?: { beforeDeadLetter?(info: { eventId: string; deliveryCount: number }): void | Promise<void> }
}

export interface ConsumerHandle {
  /** Creates the durable consumer (when a jsm was given) and starts pulling. */
  start(): Promise<void>
  stop(): Promise<void>
  /** One delivery, end to end (what the loop calls per message). */
  processMessage(msg: DeliveryMessage): Promise<DeliveryOutcome>
}

/** The part of a JsMsg the consumer uses. */
export type DeliveryMessage = Pick<JsMsg, 'subject' | 'data' | 'headers' | 'info' | 'ack' | 'nak' | 'term' | 'working'> & { ackAck?: JsMsg['ackAck'] }

/** One unacknowledged message at a time: a retrying message blocks the stream (strict per-aggregate order). */
export const CONSUMER_MAX_ACK_PENDING = 1

export const dlqSubjectFor = (tenant: string, module: string, consumer: string): string => `gremion.${tenant}.dlq.${module}.${consumer}`

export function createConsumer(opts: ConsumerOptions): ConsumerHandle {
  assertContext(opts.ctx)
  const maxDeliver = opts.maxDeliver ?? CONSUMER_MAX_DELIVER
  const backoff = opts.backoffMs ?? CONSUMER_BACKOFF_MS
  assertConsumerLimits(maxDeliver, backoff)
  const { sql, ctx } = opts
  const onError = opts.onError ?? ((err, where) => console.error(`[events] consumer ${opts.name}: ${where}:`, err))
  const log = opts.log ?? ((l) => console.info(`[events] consumer ${opts.name}: ${l}`))
  const dlqSubject = dlqSubjectFor(opts.tenant, opts.module, opts.name)
  const backoffNs = backoff.map((ms) => ms * 1_000_000)
  const workingEveryMs = Math.max(100, Math.floor(backoff[0]! / 2))
  let messages: { close(): Promise<void | Error> } | undefined
  let loop: Promise<void> | undefined
  let stopped = false

  const header = (msg: DeliveryMessage) => (name: string) => msg.headers?.get(name) || undefined

  async function publishDlq(msg: DeliveryMessage, code: string, eventId: string | undefined): Promise<void> {
    const hdrs: Record<string, string> = {}
    for (const k of msg.headers?.keys() ?? []) {
      if (k === H.msgId || (DLQ_HEADERS as readonly string[]).includes(k)) continue
      const v = msg.headers?.get(k)
      if (v) hdrs[k] = v
    }
    const seq = msg.info.streamSequence
    hdrs[H.dlqOrigSubject] = msg.subject
    hdrs[H.dlqStream] = msg.info.stream
    hdrs[H.dlqSeq] = String(seq)
    hdrs[H.dlqConsumer] = msg.info.consumer
    hdrs[H.dlqError] = code
    hdrs[H.dlqOrigMsgId] = msg.headers?.get(H.msgId) ?? ''
    // Its OWN message id: a replay that poisons the same event again must not be deduplicated away.
    const msgId = `${eventId ?? 'invalid'}.d${seq}.${opts.name}.${msg.info.deliveryCount}`
    const ack = await publishWire(opts.js, dlqSubject, msg.data, hdrs, msgId, opts.publishTimeoutMs)
    if (ack.duplicate) throw new Error(`the DLQ publish of ${msgId} was a duplicate: refusing to terminate a message whose dead letter may not be stored`)
  }

  const claimSql = `
    INSERT INTO ${ctx}.inbox AS i (source, event_id, customer_id, event_type, tenantid, event_time, traceparent,
                                   aggregate_type, aggregate_id, aggregate_version, test_run_id, processing_state)
    SELECT $1, $2, c.id, $3, c.id::text, $4::timestamptz, $5, $6, $7, $8, $9, 'received'
      FROM (SELECT ${ctx}.current_customer_id() AS id) AS c
    ON CONFLICT (source, event_id) DO UPDATE
       SET processing_state = 'received', dead_lettered_at = NULL, received_at = now()
     WHERE i.processing_state IN ('received', 'failed', 'dead_lettered')
    RETURNING processing_state`
  const failSql = `
    INSERT INTO ${ctx}.inbox AS i (source, event_id, customer_id, event_type, tenantid, event_time, traceparent,
                                   aggregate_type, aggregate_id, aggregate_version, test_run_id, processing_state,
                                   attempt_count, last_error_code)
    SELECT $1, $2, c.id, $3, c.id::text, $4::timestamptz, $5, $6, $7, $8, $9, 'failed', 1, $10
      FROM (SELECT ${ctx}.current_customer_id() AS id) AS c
    ON CONFLICT (source, event_id) DO UPDATE
       SET processing_state = 'failed', attempt_count = i.attempt_count + 1, last_error_code = EXCLUDED.last_error_code,
           received_at = now()
     WHERE i.processing_state IN ('received', 'failed', 'dead_lettered')`
  const versionSql = `
    INSERT INTO ${ctx}.applied_aggregate_version AS a (source_context, aggregate_type, aggregate_id, customer_id, applied_version, applied_event_id)
    SELECT $1, $2, $3, c.id, $4, $5 FROM (SELECT ${ctx}.current_customer_id() AS id) AS c
    ON CONFLICT (source_context, aggregate_type, aggregate_id) DO UPDATE
       SET applied_version = EXCLUDED.applied_version, applied_event_id = EXCLUDED.applied_event_id, applied_at = now()
     WHERE a.applied_version <= EXCLUDED.applied_version
    RETURNING 1`
  const markSql = `UPDATE ${ctx}.inbox SET processing_state = $3, processed_at = now(), last_error_code = NULL WHERE source = $1 AND event_id = $2`

  const claimParams = (ev: ParsedEvent) => [ev.source, ev.eventId, ev.eventType, ev.occurredAt, ev.traceparent, ev.aggregate.type, ev.aggregate.id, ev.aggregate.version, ev.testRunId]

  async function apply(ev: ConsumedEvent): Promise<'processed' | 'skipped_stale' | 'skipped_test' | 'duplicate' | 'tenant_mismatch'> {
    return inTenantTx(sql, ctx, async (tx) => {
      const [t] = await tx.unsafe<{ c: string }[]>(`SELECT ${ctx}.current_customer_id()::text AS c`)
      if (t?.c !== ev.tenantId) return 'tenant_mismatch'
      const claimed = await tx.unsafe(claimSql, claimParams(ev) as never[])
      if (claimed.length === 0) return 'duplicate'
      if (ev.testRunId && opts.reachesPeople) {
        await tx.unsafe(markSql, [ev.source, ev.eventId, 'skipped_test'])
        return 'skipped_test'
      }
      const fresh = await tx.unsafe(versionSql, [ev.sourceContext, ev.aggregate.type, ev.aggregate.id, ev.aggregate.version, ev.eventId])
      if (fresh.length === 0) {
        await tx.unsafe(markSql, [ev.source, ev.eventId, 'skipped_stale'])
        return 'skipped_stale'
      }
      await opts.handler(tx, ev)
      await tx.unsafe(markSql, [ev.source, ev.eventId, 'processed'])
      return 'processed'
    })
  }

  async function recordFailure(ev: ConsumedEvent, code: string): Promise<void> {
    await inTenantTx(sql, ctx, async (tx) => {
      await tx.unsafe(failSql, [...claimParams(ev), code] as never[])
    })
  }

  async function markDeadLettered(ev: ConsumedEvent): Promise<void> {
    await inTenantTx(sql, ctx, async (tx) => {
      await tx.unsafe(
        `UPDATE ${ctx}.inbox SET processing_state = 'dead_lettered', dead_lettered_at = now()
          WHERE source = $1 AND event_id = $2 AND processing_state IN ('received', 'failed')`,
        [ev.source, ev.eventId],
      )
    })
  }

  async function invalid(msg: DeliveryMessage, reason: string): Promise<DeliveryOutcome> {
    log(`envelope_invalid on stream seq ${msg.info.streamSequence}: ${reason}`)
    try {
      await publishDlq(msg, 'envelope_invalid', undefined)
    } catch (err) {
      onError(err, 'dead-lettering an invalid envelope')
      msg.nak(nakDelayMs(msg.info.deliveryCount, backoff))
      return 'retry'
    }
    msg.term('envelope_invalid')
    return 'envelope_invalid'
  }

  async function processMessage(msg: DeliveryMessage): Promise<DeliveryOutcome> {
    const parsed = parseEnvelope(header(msg), msg.data)
    if (!parsed.ok) return invalid(msg, parsed.problem.reason)
    const ev: ConsumedEvent = { ...parsed.event, subject: msg.subject, deliveryCount: msg.info.deliveryCount, streamSeq: msg.info.streamSequence }
    const keepAlive = setInterval(() => {
      try {
        msg.working()
      } catch {
        /* the connection may be closing */
      }
    }, workingEveryMs)
    let result: Awaited<ReturnType<typeof apply>>
    try {
      result = await apply(ev)
    } catch (err) {
      clearInterval(keepAlive)
      const code = errorCode(err, 'handler_error')
      try {
        await recordFailure(ev, code)
      } catch (recErr) {
        onError(recErr, `recording the failure of ${ev.eventId}`)
      }
      if (msg.info.deliveryCount >= maxDeliver) {
        try {
          await opts.hooks?.beforeDeadLetter?.({ eventId: ev.eventId, deliveryCount: msg.info.deliveryCount })
          await publishDlq(msg, code, ev.eventId)
          await markDeadLettered(ev)
        } catch (dlqErr) {
          // Nothing is terminated: the server's MAX_DELIVERIES advisory and the stalled gauge are the backstops.
          onError(dlqErr, `dead-lettering ${ev.eventId}`)
          if (opts.hooks?.beforeDeadLetter) throw dlqErr
          msg.nak(nakDelayMs(msg.info.deliveryCount, backoff))
          return 'retry'
        }
        msg.term(code)
        log(`event ${ev.eventId} dead-lettered after ${msg.info.deliveryCount} deliveries (${code})`)
        return 'dead_lettered'
      }
      msg.nak(nakDelayMs(msg.info.deliveryCount, backoff))
      return 'retry'
    }
    clearInterval(keepAlive)
    if (result === 'tenant_mismatch') return invalid(msg, `body tenantId ${ev.tenantId} is not this database's customer`)
    // COMMIT is behind us: a lost ack only redelivers into the inbox's duplicate path.
    try {
      if (msg.ackAck) await msg.ackAck({ timeout: 5_000 })
      else msg.ack()
    } catch (err) {
      onError(err, `acknowledging ${ev.eventId} (it will be redelivered and ignored as a duplicate)`)
    }
    return result
  }

  async function ensureConsumer(): Promise<void> {
    if (!opts.jsm) return
    // Strict per-aggregate order (operator decision 2026-10-21): max_ack_pending 1 means the server hands
    // out ONE message at a time, so a nak'd message (waiting out its BackOff) blocks the stream until it
    // is processed or dead-lettered; a later version is never applied ahead of a pending earlier one.
    const existing = await opts.jsm.consumers.info(opts.stream, opts.name).catch((err: unknown) => {
      if (err instanceof JetStreamApiError && err.apiError().err_code === JetStreamApiCodes.ConsumerNotFound) return undefined
      throw err
    })
    if (existing) {
      // consumers.add on an existing durable with another config is an error, and silently keeping the old
      // one would run a consumer that is not what the caller configured. EVERY field this function sets is
      // compared: the mutable ones are UPDATED (and logged), an immutable one that differs is refused by name.
      const cfg = existing.config
      const wantDeliver = opts.startFrom === 'new' ? DeliverPolicy.New : DeliverPolicy.All
      if (cfg.ack_policy !== AckPolicy.Explicit) {
        throw new Error(`durable consumer ${opts.name} on ${opts.stream}: ack_policy is ${cfg.ack_policy}, expected ${AckPolicy.Explicit}; it cannot be updated: delete the consumer (or use another name) and start again`)
      }
      if (cfg.deliver_policy !== wantDeliver) {
        throw new Error(`durable consumer ${opts.name} on ${opts.stream}: deliver_policy is ${cfg.deliver_policy}, expected ${wantDeliver} (startFrom ${opts.startFrom ?? 'all'}); it cannot be updated: delete the consumer (or use another name) and start again`)
      }
      if (cfg.filter_subjects && cfg.filter_subjects.length > 0) {
        throw new Error(`durable consumer ${opts.name} on ${opts.stream}: it has filter_subjects ${JSON.stringify(cfg.filter_subjects)}, this consumer sets a single filter_subject; delete the consumer and start again`)
      }
      const update: Record<string, unknown> = {}
      const changes: string[] = []
      const want = (field: string, have: unknown, wanted: unknown, key: string = field) => {
        if (JSON.stringify(have) === JSON.stringify(wanted)) return
        update[key] = wanted
        changes.push(`${field} ${JSON.stringify(have ?? null)} -> ${JSON.stringify(wanted)}`)
      }
      want('max_ack_pending', cfg.max_ack_pending, CONSUMER_MAX_ACK_PENDING)
      want('max_deliver', cfg.max_deliver, maxDeliver)
      want('backoff', cfg.backoff ?? [], backoffNs)
      want('filter_subject', cfg.filter_subject || undefined, opts.filterSubject || undefined)
      if (changes.length > 0) {
        // An unset filter is the empty string on the wire.
        if ('filter_subject' in update && update.filter_subject === undefined) update.filter_subject = ''
        await opts.jsm.consumers.update(opts.stream, opts.name, update)
        log(`durable consumer ${opts.name} on ${opts.stream}: config drift updated: ${changes.join('; ')}`)
      }
      return
    }
    await opts.jsm.consumers.add(opts.stream, {
      name: opts.name,
      durable_name: opts.name,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: opts.startFrom === 'new' ? DeliverPolicy.New : DeliverPolicy.All,
      max_deliver: maxDeliver,
      max_ack_pending: CONSUMER_MAX_ACK_PENDING,
      backoff: backoffNs,
      ...(opts.filterSubject ? { filter_subject: opts.filterSubject } : {}),
    })
  }

  return {
    processMessage,
    async start() {
      stopped = false
      await ensureConsumer()
      const consumer = await opts.js.consumers.get(opts.stream, opts.name)
      // One message in flight (max_ack_pending 1): never request a batch, and the loop below awaits each message.
      const it = await consumer.consume({ max_messages: 1 })
      messages = it
      loop = (async () => {
        for await (const m of it) {
          if (stopped) break
          try {
            await processMessage(m)
          } catch (err) {
            onError(err, 'processing a message (left unacknowledged)')
          }
        }
      })().catch((err: unknown) => {
        if (!stopped) onError(err, 'the pull loop ended')
      })
    },
    async stop() {
      stopped = true
      await messages?.close()
      await loop
    },
  }
}
