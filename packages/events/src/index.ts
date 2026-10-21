// @gremion/events -- transactional outbox, idempotent inbox, relay, consumer and
// dead-letter handling for the Gremion service databases (TASK-079, CAP-EVENTS;
// TRD-420, TRD-421, TRD-422). The library never opens a connection: services
// pass a tenant-store `Sql` and a nats-auth identity's JetStream client.
export { plumbingSql, checkPlumbingMigration, checkPlumbingText, PlumbingDriftError } from './plumbing.ts'
export { enqueue, isTransaction, EnqueueError } from './enqueue.ts'
export type { EnqueueInput } from './enqueue.ts'
export { createRelay, subjectOf } from './relay.ts'
export type { PassResult, Relay, RelayOptions, SubjectMap } from './relay.ts'
export { createConsumer, dlqSubjectFor } from './consumer.ts'
export type { ConsumedEvent, ConsumerHandle, ConsumerOptions, DeliveryMessage, DeliveryOutcome, EventHandler } from './consumer.ts'
export { replayOutbox, requeueOutbox, replayDeadLetter, listDeadLetters, RecoveryError, DLQ_STREAM, ADVISORY_PREFIX } from './recovery.ts'
export type { DlqEntry, ReplayDeadLetterResult, ReplayOutboxOptions } from './recovery.ts'
export { collectMetrics, renderMetrics } from './metrics.ts'
export type { EventMetrics, MetricsOptions } from './metrics.ts'
export { H, REQUIRED_HEADERS, OPTIONAL_HEADERS, DLQ_HEADERS, bodyOf, headersOf, parseEnvelope, contextOfSource, correlationOf } from './envelope.ts'
export type { OutboxRow, ParsedEvent, WireEnvelope } from './envelope.ts'
export { publishWire, publishRow } from './publish.ts'
export type { Publisher, PubResult } from './publish.ts'
export { CONSUMER_BACKOFF_MS, CONSUMER_MAX_DELIVER, RELAY_MAX_ATTEMPTS, STALLED_AFTER_MS, nakDelayMs, relayBackoffMs } from './backoff.ts'
export { inTenantTx } from './db.ts'
