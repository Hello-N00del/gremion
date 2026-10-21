// packages/events/src/envelope.ts (@gremion/events)
//
// The wire contract of one relayed event (TASK-079 Q6): today's EventEnvelope
// body (@gremion/ports/broker) plus Gremion-* headers and W3C `traceparent`.
// The legacy body shape is what TASK-189's dual-read must accept; CloudEvents
// binary mode is TASK-189's. Pure: no database, no broker.
//
// Stable identity (TRD-422): outbox.event_id = body eventId = Gremion-Event-Id
// = the relay's Nats-Msg-Id. The inbox key is (Gremion-Source, eventId) and is
// NEVER taken from Nats-Msg-Id (a replay publishes under its own msg id).

export const H = {
  msgId: 'Nats-Msg-Id',
  eventId: 'Gremion-Event-Id',
  source: 'Gremion-Source',
  aggregateType: 'Gremion-Aggregate-Type',
  aggregateId: 'Gremion-Aggregate-Id',
  aggregateVersion: 'Gremion-Aggregate-Version',
  testRunId: 'Gremion-Test-Run-Id',
  traceparent: 'traceparent',
  dlqOrigSubject: 'Gremion-Dlq-Orig-Subject',
  dlqStream: 'Gremion-Dlq-Stream',
  dlqSeq: 'Gremion-Dlq-Seq',
  dlqConsumer: 'Gremion-Dlq-Consumer',
  dlqError: 'Gremion-Dlq-Error',
  dlqOrigMsgId: 'Gremion-Dlq-Orig-Msg-Id',
} as const

/** The headers every relayed message carries (the optional two are listed apart). */
export const REQUIRED_HEADERS = [H.msgId, H.eventId, H.source, H.aggregateType, H.aggregateId, H.aggregateVersion] as const
export const OPTIONAL_HEADERS = [H.testRunId, H.traceparent] as const

export const DLQ_HEADERS = [H.dlqOrigSubject, H.dlqStream, H.dlqSeq, H.dlqConsumer, H.dlqError, H.dlqOrigMsgId] as const

/** The JSON body on the wire: field-matched to @gremion/ports EventEnvelope. */
export interface WireEnvelope {
  eventId: string
  eventType: string
  tenantId: string
  occurredAt: string
  correlationId: string | null
  payload: Record<string, unknown>
}

/** What the relay needs of one outbox row. */
export interface OutboxRow {
  event_id: string
  customer_id: string
  event_type: string
  source: string
  subject: string | null
  event_time: Date
  data: Record<string, unknown>
  traceparent: string | null
  aggregate_type: string
  aggregate_id: string
  aggregate_version: string | number | bigint
  test_run_id: string | null
}

const TRACEPARENT = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SOURCE = /^\/gremion\/([a-z]{2,4})$/

/** The context code of a source (`/gremion/idt` -> `idt`), or undefined. */
export function contextOfSource(source: string): string | undefined {
  return SOURCE.exec(source)?.[1]
}

/** correlationId: the trace id of the outbox traceparent, else null. */
export function correlationOf(traceparent: string | null): string | null {
  return traceparent ? (TRACEPARENT.exec(traceparent)?.[1] ?? null) : null
}

export function bodyOf(row: OutboxRow): WireEnvelope {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    tenantId: row.customer_id,
    occurredAt: row.event_time.toISOString(),
    correlationId: correlationOf(row.traceparent),
    payload: row.data,
  }
}

/** The relay's headers for one row, as a plain map (the transport turns it into NATS headers). */
export function headersOf(row: OutboxRow): Record<string, string> {
  const h: Record<string, string> = {
    [H.msgId]: row.event_id,
    [H.eventId]: row.event_id,
    [H.source]: row.source,
    [H.aggregateType]: row.aggregate_type,
    [H.aggregateId]: row.aggregate_id,
    [H.aggregateVersion]: String(row.aggregate_version),
  }
  if (row.test_run_id) h[H.testRunId] = row.test_run_id
  if (row.traceparent) h[H.traceparent] = row.traceparent
  return h
}

/** A message as the consumer validated it. */
export interface ParsedEvent {
  eventId: string
  source: string
  /** The producing context (`idt` for `/gremion/idt`). */
  sourceContext: string
  eventType: string
  tenantId: string
  occurredAt: string
  correlationId: string | null
  payload: Record<string, unknown>
  aggregate: { type: string; id: string; version: number }
  testRunId: string | null
  traceparent: string | null
}

export type EnvelopeProblem = { code: 'envelope_invalid'; reason: string }

/**
 * Validates headers and body of a delivered message. Never throws: a message
 * that fails is dead-lettered as envelope_invalid, never applied.
 */
export function parseEnvelope(get: (name: string) => string | undefined, data: Uint8Array): { ok: true; event: ParsedEvent } | { ok: false; problem: EnvelopeProblem } {
  const bad = (reason: string) => ({ ok: false as const, problem: { code: 'envelope_invalid' as const, reason } })
  for (const name of REQUIRED_HEADERS) {
    if (!get(name)) return bad(`missing header ${name}`)
  }
  const eventId = get(H.eventId)!
  const source = get(H.source)!
  const sourceContext = contextOfSource(source)
  if (!sourceContext) return bad(`header ${H.source} ${JSON.stringify(source)} is not /gremion/<ctx>`)
  const aggregateId = get(H.aggregateId)!
  if (!UUID.test(aggregateId)) return bad(`header ${H.aggregateId} is not a uuid`)
  const aggregateType = get(H.aggregateType)!
  if (!/^[a-z]{1,40}$/.test(aggregateType)) return bad(`header ${H.aggregateType} is not [a-z]{1,40}`)
  const versionText = get(H.aggregateVersion)!
  if (!/^[1-9][0-9]{0,14}$/.test(versionText)) return bad(`header ${H.aggregateVersion} is not a positive integer`)
  const testRunId = get(H.testRunId) ?? null
  if (testRunId !== null && !UUID.test(testRunId)) return bad(`header ${H.testRunId} is not a uuid`)
  const traceparent = get(H.traceparent) ?? null
  if (traceparent !== null && !TRACEPARENT.test(traceparent)) return bad(`header ${H.traceparent} is not a W3C traceparent`)
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(data))
  } catch {
    return bad('the body is not JSON')
  }
  const b = body as Partial<WireEnvelope> | null
  if (!b || typeof b !== 'object') return bad('the body is not an object')
  if (b.eventId !== eventId) return bad(`body eventId differs from header ${H.eventId}`)
  if (typeof b.eventType !== 'string' || !b.eventType) return bad('the body has no eventType')
  if (typeof b.tenantId !== 'string' || !b.tenantId) return bad('the body has no tenantId')
  if (typeof b.occurredAt !== 'string' || Number.isNaN(Date.parse(b.occurredAt))) return bad('the body has no valid occurredAt')
  if (!b.payload || typeof b.payload !== 'object' || Array.isArray(b.payload)) return bad('the body has no payload object')
  return {
    ok: true,
    event: {
      eventId,
      source,
      sourceContext,
      eventType: b.eventType,
      tenantId: b.tenantId,
      occurredAt: b.occurredAt,
      correlationId: typeof b.correlationId === 'string' ? b.correlationId : null,
      payload: b.payload as Record<string, unknown>,
      aggregate: { type: aggregateType, id: aggregateId, version: Number(versionText) },
      testRunId,
      traceparent,
    },
  }
}
