// packages/events/src/recovery.ts (@gremion/events)
//
// The recovery verbs of the dead-letter runbook (docs/runbooks/dead-letter.md):
//
//   requeueOutbox   a `dead_lettered` outbox row goes back to `pending`, counters cleared;
//   replayOutbox    after a JetStream wipe, republish the `published` rows under their own ids
//                   (the rebuild: the outbox outlives the stream, TRD-422);
//   listDeadLetters / replayDeadLetter
//                   re-deliver a DLQ entry after the fix, and delete it only after the PubAck.
//
// replayDeadLetter runs as the tenant's `admin` (it reads STREAM.MSG.GET and deletes
// from the DLQ stream): a module key can do neither (TASK-024).
import type { Sql } from '@gremion/db'
import { FLOWS } from '@gremion/nats-auth'
import { JetStreamApiCodes, JetStreamApiError, type JetStreamManager } from '@nats-io/jetstream'
import { inTenantTx } from './db.ts'
import { DLQ_HEADERS, H, type OutboxRow } from './envelope.ts'
import { assertContext } from './plumbing.ts'
import { publishRow, publishWire, type Publisher } from './publish.ts'
import { subjectOf, type SubjectMap } from './relay.ts'

export const DLQ_STREAM = 'DLQ'
export const ADVISORY_PREFIX = '$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.'

export class RecoveryError extends Error {
  override name = 'RecoveryError'
}

/** dead_lettered -> pending, attempt_count and dead_lettered_at cleared; the relay then publishes it. */
export async function requeueOutbox(sql: Sql, opts: { ctx: string; eventId: string }): Promise<void> {
  assertContext(opts.ctx)
  const rows = await inTenantTx(sql, opts.ctx, (tx) =>
    tx.unsafe<{ event_id: string }[]>(
      `UPDATE ${opts.ctx}.outbox
          SET relay_state = 'pending', dead_lettered_at = NULL, attempt_count = 0, last_error_code = NULL, next_attempt_at = now()
        WHERE event_id = $1 AND relay_state = 'dead_lettered'
        RETURNING event_id`,
      [opts.eventId],
    ),
  )
  if (rows.length === 0) throw new RecoveryError(`[events] no dead_lettered outbox row ${opts.eventId} in ${opts.ctx}.outbox (nothing requeued)`)
}

export interface ReplayOutboxOptions {
  ctx: string
  subjects: SubjectMap
  /** Only rows published at or after this instant (default: every published row). */
  since?: Date
  batchSize?: number
  log?: (line: string) => void
}

/** Republishes `published` rows, in publish order (published_at, event_id), each under its own event_id. Returns how many. */
export async function replayOutbox(sql: Sql, js: Publisher, opts: ReplayOutboxOptions): Promise<{ republished: number }> {
  assertContext(opts.ctx)
  const batch = opts.batchSize ?? 200
  const log = opts.log ?? ((l) => console.info(`[events] ${l}`))
  // t is the server's own text rendering of published_at: a JS Date would cut the microseconds and the keyset would re-read its page forever.
  let after: { t: string; id: string } | undefined
  let republished = 0
  for (;;) {
    const rows = await inTenantTx(sql, opts.ctx, (tx) =>
      tx.unsafe<(OutboxRow & { published_cursor: string })[]>(
        `SELECT event_id, customer_id, event_type, source, subject, event_time, data, traceparent,
                aggregate_type, aggregate_id, aggregate_version, test_run_id, published_at::text AS published_cursor
           FROM ${opts.ctx}.outbox
          WHERE relay_state = 'published'
            AND ($1::timestamptz IS NULL OR published_at >= $1::timestamptz)
            AND ($2::timestamptz IS NULL OR (published_at, event_id) > ($2::timestamptz, $3::uuid))
          ORDER BY published_at, event_id
          LIMIT $4`,
        [opts.since?.toISOString() ?? null, after?.t ?? null, after?.id ?? null, batch],
      ),
    )
    if (rows.length === 0) break
    for (const row of rows) {
      await publishRow(js, subjectOf(opts.subjects, row), row)
      republished++
    }
    const last = rows[rows.length - 1]!
    after = { t: last.published_cursor, id: last.event_id }
    if (rows.length < batch) break
  }
  log(`outbox-replay ${opts.ctx}: republished ${republished} published row(s)`)
  return { republished }
}

export interface DlqEntry {
  seq: number
  /** The subject the entry was stored under (a consumer dead letter or the advisory). */
  subject: string
  kind: 'consumer' | 'advisory'
  eventId: string | undefined
  /** consumer entries: the Gremion-Dlq-Error code. */
  error: string | undefined
  /** The original subject (consumer entries) or undefined (advisory entries). */
  origSubject: string | undefined
  stream: string | undefined
  streamSeq: number | undefined
  consumer: string | undefined
  time: string
}

type Streams = Pick<JetStreamManager, 'streams'>

/** The streams this package's deployments create: every flow stream (@gremion/nats-auth FLOWS) plus the DLQ. */
export const KNOWN_STREAMS: readonly string[] = Object.freeze([...new Set([DLQ_STREAM, ...Object.values(FLOWS).flatMap((f) => [...f.publishes, ...f.consumes])])])

type Stored = NonNullable<Awaited<ReturnType<Streams['streams']['getMessage']>>>

/**
 * STREAM.MSG.GET where ONLY "not found" (no such message, no such stream) is null; a timeout, a permission
 * denial or a closed connection is a RecoveryError naming the real cause, never "the message is gone".
 */
async function fetchStored(jsm: Streams, stream: string, seq: number): Promise<Stored | null> {
  try {
    return (await jsm.streams.getMessage(stream, { seq })) ?? null
  } catch (err) {
    if (err instanceof JetStreamApiError) {
      const code = err.apiError().err_code
      if (code === JetStreamApiCodes.NoMessageFound || code === JetStreamApiCodes.StreamNotFound) return null
    }
    const e = err as { name?: unknown; message?: unknown }
    throw new RecoveryError(`[events] could not read ${stream}#${seq}: ${typeof e?.name === 'string' ? e.name : 'Error'}: ${typeof e?.message === 'string' ? e.message : String(err)} (this is not "gone": fix the cause and retry)`, { cause: err })
  }
}

function toEntry(m: { seq: number; subject: string; header: { get(k: string): string }; data: Uint8Array; time: Date }): DlqEntry {
  const base = { seq: m.seq, subject: m.subject, time: m.time.toISOString() }
  if (m.subject.startsWith(ADVISORY_PREFIX)) {
    let adv: { stream?: string; consumer?: string; stream_seq?: number } = {}
    try {
      adv = JSON.parse(new TextDecoder().decode(m.data)) as typeof adv
    } catch {
      /* an unreadable advisory is still listed */
    }
    return { ...base, kind: 'advisory', eventId: undefined, error: 'max_deliveries', origSubject: undefined, stream: adv.stream, streamSeq: adv.stream_seq, consumer: adv.consumer }
  }
  const seq = m.header.get(H.dlqSeq)
  return {
    ...base,
    kind: 'consumer',
    eventId: m.header.get(H.eventId) || undefined,
    error: m.header.get(H.dlqError) || undefined,
    origSubject: m.header.get(H.dlqOrigSubject) || undefined,
    stream: m.header.get(H.dlqStream) || undefined,
    streamSeq: seq ? Number(seq) : undefined,
    consumer: m.header.get(H.dlqConsumer) || undefined,
  }
}

/** Every entry of the tenant's DLQ stream, oldest first. */
export async function listDeadLetters(jsm: Streams, opts: { stream?: string } = {}): Promise<DlqEntry[]> {
  const stream = opts.stream ?? DLQ_STREAM
  const info = await jsm.streams.info(stream)
  const out: DlqEntry[] = []
  if (info.state.messages === 0) return out
  for (let seq = info.state.first_seq; seq <= info.state.last_seq; seq++) {
    const m = await fetchStored(jsm, stream, seq)
    if (m) out.push(toEntry(m))
  }
  return out
}

export interface ReplayDeadLetterOptions {
  seq: number
  stream?: string
  /** The streams an entry may name as its source (default: the flow streams of KNOWN_STREAMS; the DLQ itself is never a source). */
  allowedStreams?: readonly string[]
  log?: (line: string) => void
}

export interface ReplayDeadLetterResult {
  dlqSeq: number
  kind: 'consumer' | 'advisory'
  republishedTo: string
  msgId: string
  /** True when the PubAck said the broker already held this replay's message id. */
  duplicate: boolean
}

const stripped = (h: { keys(): string[]; get(k: string): string }): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const k of h.keys()) {
    if (k === H.msgId || (DLQ_HEADERS as readonly string[]).includes(k)) continue
    const v = h.get(k)
    if (v) out[k] = v
  }
  return out
}

/**
 * Re-delivers one DLQ entry: the ORIGINAL message is fetched from its source stream by stream
 * sequence (STREAM.MSG.GET, admin only) and republished; the DLQ record's own body and headers
 * are never trusted, and a consumer record whose event id differs from the original's is refused. Message id <event_id>.r<dlq_seq>. The DLQ entry is deleted ONLY after
 * a successful PubAck. Q14: a replayed event whose aggregate has moved on (the consumer's strict
 * order, max_ack_pending 1, only prevents this while the message is still retrying; once it is
 * dead-lettered the stream continues) ends `skipped_stale` in the consumer; the log line says so.
 */
export async function replayDeadLetter(
  jsm: Streams,
  /**
   * Where the re-delivery is published. The tenant admin may not publish stream subjects (and must not:
   * TASK-024), so the caller passes the PUBLISHER of the target stream (FLOWS: exactly one per stream)
   * as a function of the stream the entry belongs to, or one client when it knows the stream already.
   */
  js: Publisher | ((targetStream: string) => Promise<Publisher>),
  opts: ReplayDeadLetterOptions,
): Promise<ReplayDeadLetterResult> {
  const stream = opts.stream ?? DLQ_STREAM
  const log = opts.log ?? ((l) => console.info(`[events] ${l}`))
  const entry = await fetchStored(jsm, stream, opts.seq)
  if (!entry) throw new RecoveryError(`[events] DLQ entry ${opts.seq} does not exist in ${stream} (already replayed, or expired: after its 7 days use outbox-replay)`)
  const kind = toEntry(entry).kind
  // The DLQ record is NOT trusted (its headers and body are writable by whoever can publish the DLQ
  // subject): both kinds re-fetch the ORIGINAL from its source stream by stream sequence and replay
  // THAT payload and those headers. A consumer record must additionally still name the same event id.
  let origStream: string | undefined
  let origSeq: number | undefined
  let recordEventId: string | undefined
  if (kind === 'consumer') {
    origStream = entry.header.get(H.dlqStream) || undefined
    origSeq = Number(entry.header.get(H.dlqSeq) || '') || undefined
    recordEventId = entry.header.get(H.eventId) || undefined
  } else {
    const adv = JSON.parse(new TextDecoder().decode(entry.data)) as { stream?: string; stream_seq?: number }
    origStream = adv.stream
    origSeq = adv.stream_seq
  }
  if (!origStream || !origSeq) throw new RecoveryError(`[events] DLQ entry ${opts.seq} names no source stream/stream sequence: it cannot be replayed (use outbox-replay)`)
  const allowed = opts.allowedStreams ?? KNOWN_STREAMS.filter((s) => s !== DLQ_STREAM)
  if (origStream === stream || !allowed.includes(origStream)) {
    throw new RecoveryError(`[events] refusing to replay DLQ entry ${opts.seq}: it names source stream ${JSON.stringify(origStream)}, which is not one of ${allowed.join(', ')}`)
  }
  const original = await fetchStored(jsm, origStream, origSeq)
  if (!original) throw new RecoveryError(`[events] the original message ${origStream}#${origSeq} is gone (7-day retention): re-deliver it with outbox-replay`)
  const originalEventId = original.header.get(H.eventId) || undefined
  if (kind === 'consumer' && originalEventId !== recordEventId) {
    throw new RecoveryError(
      `[events] refusing to replay DLQ entry ${opts.seq}: the original ${origStream}#${origSeq} has event id ${originalEventId ?? '(none)'} but the DLQ record says ${recordEventId ?? '(none)'}`,
    )
  }
  // Identity: a consumer record names the subject it dead-lettered; and the original can never be YOUNGER than
  // the record about it, so a stream that was recreated (its sequences restarted) cannot hand a different,
  // later message to an old entry's stream_seq.
  const origSubjectInRecord = kind === 'consumer' ? entry.header.get(H.dlqOrigSubject) || undefined : undefined
  if (kind === 'consumer' && origSubjectInRecord !== original.subject) {
    throw new RecoveryError(
      `[events] refusing to replay DLQ entry ${opts.seq}: the original ${origStream}#${origSeq} was published to ${original.subject} but the DLQ record says ${origSubjectInRecord ?? '(none)'}`,
    )
  }
  if (original.time.getTime() > entry.time.getTime()) {
    throw new RecoveryError(
      `[events] refusing to replay DLQ entry ${opts.seq}: ${origStream}#${origSeq} was stored at ${original.time.toISOString()}, after the DLQ entry (${entry.time.toISOString()}): the stream was recreated, its sequence now names another message (use outbox-replay)`,
    )
  }
  const targetStream: string = origStream
  const subject: string = original.subject
  const body: Uint8Array = original.data
  const hdrs: Record<string, string> = stripped(original.header)
  const eventId: string | undefined = originalEventId
  const msgId = `${eventId ?? `s${opts.seq}`}.r${opts.seq}`
  let publisher: Publisher
  if (typeof js === 'function') {
    if (!targetStream) throw new RecoveryError(`[events] DLQ entry ${opts.seq} does not name its stream: cannot choose the publisher`)
    publisher = await js(targetStream)
  } else {
    publisher = js
  }
  const ack = await publishWire(publisher, subject, body, hdrs, msgId)
  await jsm.streams.deleteMessage(stream, opts.seq, true)
  log(
    `dlq-replay: ${kind} entry ${opts.seq} (event ${eventId ?? 'unknown'}) republished to ${subject} as ${msgId}${ack.duplicate ? ' (the broker already held it)' : ''}, entry deleted. ` +
      'If the aggregate already moved to a newer version, the consumer ends this event as skipped_stale (Q14).',
  )
  return { dlqSeq: opts.seq, kind, republishedTo: subject, msgId, duplicate: ack.duplicate }
}
