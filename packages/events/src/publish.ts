// packages/events/src/publish.ts (@gremion/events)
//
// One JetStream publish with headers. The relay, the outbox replay and the DLQ
// replay all go through publishWire, so Nats-Msg-Id, the Gremion-* headers and
// `traceparent` are set in exactly one place.
import { headers as natsHeaders } from '@nats-io/nats-core'
import type { JetStreamClient } from '@nats-io/jetstream'
import { bodyOf, headersOf, H, type OutboxRow } from './envelope.ts'

/** What the library needs of a JetStream client: a JetStreamClient satisfies it. */
export type Publisher = Pick<JetStreamClient, 'publish'>

export interface PubResult {
  stream: string
  seq: number
  duplicate: boolean
}

export const DEFAULT_PUBLISH_TIMEOUT_MS = 5_000

/** Publishes `body` with `hdrs` under `msgId` and awaits the PubAck. */
export async function publishWire(
  js: Publisher,
  subject: string,
  body: string | Uint8Array,
  hdrs: Record<string, string>,
  msgId: string,
  timeoutMs = DEFAULT_PUBLISH_TIMEOUT_MS,
): Promise<PubResult> {
  const h = natsHeaders()
  for (const [k, v] of Object.entries({ ...hdrs, [H.msgId]: msgId })) h.set(k, v)
  const ack = await js.publish(subject, body, { msgID: msgId, headers: h, timeout: timeoutMs })
  return { stream: ack.stream, seq: ack.seq, duplicate: ack.duplicate }
}

/** An outbox row on the wire: its own event_id as the message id (stable identity). */
export function publishRow(js: Publisher, subject: string, row: OutboxRow, timeoutMs?: number): Promise<PubResult> {
  return publishWire(js, subject, JSON.stringify(bodyOf(row)), headersOf(row), row.event_id, timeoutMs)
}
