// gremion-ui/src/lib/server/events/newsletter-audit-consumer.ts
//
// T15 (P1 / D-P1-7): monolith-side NATS consumer that translates newsletter
// send events into audit_log rows via the idempotency table event_consumption.
//
// Design:
//  - Subscribes STREAMS.NEWSLETTER's own subject filter — the same list
//    ensureStream() hands the server, so the pattern cannot drift from the
//    stream that has to cover it. It matches the 5-token subjects that
//    newsletterSubject() builds (send.succeeded, send.failed).
//  - Per event (inside one DB transaction):
//      1. INSERT event_consumption ON CONFLICT DO NOTHING.
//      2. If 0 rows inserted → already processed → ack + skip (idempotent gate).
//      3. Else write audit_log row with field = NewsletterEvent value (no string
//         literals — switched against the shared NewsletterEvent type from
//         @gremion/ports/broker), value = payload JSON, correlation_id from envelope.
//  - Unknown tenantId (not in registry) → log + ack-skip (no crash, no retry).
//  - Boot wiring: startNewsletterAuditConsumer() is called from hooks.server.ts
//    inside the boot() function, env-gated on NATS_URL being set.
//    Absent NATS_URL → consumer stays off, one console.info logged.
//
// Pattern constraint (D-P1-7): tests subscribe with the SAME pattern the durable
// consumer uses, never a test-only literal. This is enforced by only exporting
// the pattern constant NEWSLETTER_CONSUMER_PATTERN and using it in both
// subscribe() and the test harness.

import type { BrokerPort, EventEnvelope } from '@gremion/ports/broker'
import type { NewsletterEvent } from '@gremion/ports/broker'
import { STREAMS } from '@gremion/ports/broker'
import { noopTracer, type TracerPort } from '@gremion/ports/tracer'
import { getDb } from '$lib/server/db'
import { resolveTenantById } from '$lib/server/tenant/registry'
import { runWithTenant } from '$lib/server/tenant/context'
import { noteWorkerFault } from './consumer-state'

/** The consumer name used as the deduplication key in event_consumption. */
export const NEWSLETTER_AUDIT_CONSUMER = 'monolith:newsletter-audit'

/** Subject pattern this consumer subscribes to — DERIVED from the NEWSLETTER
 *  stream's own filter, never restated. A literal here would be a SECOND
 *  definition of the wire root, and the kernel's SUBJECT_ROOT rename is exactly
 *  the drift that makes a second definition silent: NatsBroker.subscribe() would
 *  reject `ready` with StreamCoverError while the InMemoryBroker the integration
 *  tests use went on delivering. Used by both the runtime and those tests —
 *  subscribing to the SAME pattern is what ensures wildcard parity. */
export const NEWSLETTER_CONSUMER_PATTERN = STREAMS.NEWSLETTER.subjects[0]!

/** Map a NewsletterEvent to the audit_log `field` value. Uses the shared type
 *  from @gremion/ports/broker — NO string literals here. */
function auditField(eventType: NewsletterEvent): string {
  switch (eventType) {
    case 'send.succeeded':
      return 'newsletter_sent'
    case 'send.failed':
      return 'newsletter_send_failed'
  }
}

/** Guard: is the eventType one of the known NewsletterEvent values? */
function isNewsletterEvent(eventType: string): eventType is NewsletterEvent {
  return eventType === 'send.succeeded' || eventType === 'send.failed'
}

/**
 * Process one event envelope inside the tenant's data-plane DB.
 * Must be called inside runWithTenant(ctx, …).
 *
 * Returns 'consumed' | 'duplicate' | 'unknown-event'.
 */
async function processEnvelope(envelope: EventEnvelope): Promise<'consumed' | 'duplicate' | 'unknown-event'> {
  if (!isNewsletterEvent(envelope.eventType)) {
    return 'unknown-event'
  }

  const sql = getDb()
  const field = auditField(envelope.eventType)

  const result = await sql.begin(async (tx) => {
    // Idempotency gate: INSERT ON CONFLICT DO NOTHING
    const inserted = await tx<{ event_id: string }[]>`
      INSERT INTO event_consumption (consumer, event_id)
      VALUES (${NEWSLETTER_AUDIT_CONSUMER}, ${envelope.eventId})
      ON CONFLICT (consumer, event_id) DO NOTHING
      RETURNING event_id
    `

    if (inserted.length === 0) {
      // Already processed — duplicate delivery.
      return 'duplicate' as const
    }

    // Write the audit row.
    await tx`
      INSERT INTO audit_log (user_id, field, old_value, new_value, correlation_id)
      VALUES (
        ${'newsletter-service'},
        ${field},
        ${null},
        ${JSON.stringify(envelope.payload)},
        ${envelope.correlationId ?? null}
      )
    `

    return 'consumed' as const
  })

  return result
}

/**
 * Wire the consumer onto the given BrokerPort. In production this is a
 * NatsBroker; in integration tests this is the InMemoryBroker.
 *
 * Returns the BrokerSubscription so callers can unsubscribe on shutdown.
 *
 * @param broker  The broker to subscribe on.
 * @param tracer  T16 (D-P1-8): optional TracerPort for span emission.
 *                Each handled envelope is wrapped in a 'newsletter.audit.consume'
 *                span carrying the envelope's correlationId. Defaults to noopTracer.
 */
export function wireNewsletterAuditConsumer(broker: BrokerPort, tracer: TracerPort = noopTracer) {
  return broker.subscribe(
    NEWSLETTER_CONSUMER_PATTERN,
    async (envelope: EventEnvelope) => {
      const tenantId = envelope.tenantId

      // T16 (D-P1-8): span wraps the full envelope handling lifecycle.
      const span = tracer.startSpan('newsletter.audit.consume', {
        eventType: envelope.eventType,
        tenant: tenantId,
        correlationId: envelope.correlationId ?? 'none',
      })

      // Resolve the tenant from the registry (active tenants only). The envelope
      // is keyed by the tenant UUID (envelope.tenantId), NOT the slug, so we MUST
      // resolve BY ID — resolveTenantBySlug(uuid) validateSlug-rejects every UUID
      // and would ack-skip every real event (the live-cutover bug this fixes).
      const ctx = await resolveTenantById(tenantId)
      if (!ctx) {
        console.warn(
          `[newsletter-audit-consumer] unknown/inactive tenant "${tenantId}" for event ${envelope.eventId} — ack-skip`,
        )
        span.end()
        return
      }

      await runWithTenant(ctx, async () => {
        try {
          const outcome = await processEnvelope(envelope)
          if (outcome === 'duplicate') {
            console.debug(
              `[newsletter-audit-consumer] duplicate event ${envelope.eventId} (tenant ${tenantId}) — ack-skip`,
            )
          }
          // 'unknown-event' and 'consumed' both ack (no retry needed for unknown events).
          span.end()
        } catch (err) {
          span.end(err)
          throw err
        }
      })
    },
  )
}

/** The id this consumer reports under in /api/health. */
export const NEWSLETTER_AUDIT_WORKER = 'newsletter-audit-consumer'

/** What the boot needs from a broker beyond BrokerPort — injectable for tests. */
export interface AuditBroker extends BrokerPort {
  // Mirrors NatsBroker.ensureStream: it takes a MUTABLE string[] (the stream
  // config it hands the server), and STREAMS.*.subjects are mutable arrays.
  ensureStream(name: string, subjects: string[]): Promise<void>
  close(): Promise<void>
}

let _started = false

/**
 * Start the newsletter audit consumer. Called from newsletter/register.server.ts
 * via superviseWorker(), which owns the bounded restart schedule; this function
 * owns ONE attempt and either comes up or throws.
 *
 * Absent NATS_URL → the caller never gets here and marks the worker `off`
 * (staging-safe until compose wires it).
 *
 * `_started` latches only AFTER the subscription is live. Round 1 set it on the
 * first line, before awaiting anything, so a boot that failed could never be
 * retried in that process. And the broker is CLOSED when the attempt fails —
 * otherwise each retry would stack another live NATS connection.
 *
 * @param tracer  F3 (T16): optional TracerPort for newsletter.audit.consume spans.
 *                Pass makeLogTracer when TRACE_EXPORTER=log; defaults to noopTracer.
 * @param connect Optional broker factory (tests inject a double).
 */
export async function startNewsletterAuditConsumer(
  natsUrl: string,
  tracer?: TracerPort,
  connect?: () => Promise<AuditBroker>,
): Promise<void> {
  if (_started) return

  const open =
    connect ??
    (async (): Promise<AuditBroker> => {
      const { NatsBroker } = await import('@gremion/ports/nats')
      // WP-A: bind the NEWSLETTER stream explicitly by descriptor (behaviourally
      // identical to the pre-WP-A connect(url)/ensureStream() defaults) so every
      // leaf consumer targets its domain's stream via the shared STREAMS topology.
      return NatsBroker.connect(natsUrl, STREAMS.NEWSLETTER.name)
    })

  const broker = await open()
  try {
    await broker.ensureStream(STREAMS.NEWSLETTER.name, STREAMS.NEWSLETTER.subjects)
    const sub = wireNewsletterAuditConsumer(broker, tracer)
    // A returned subscription is not a LIVE one. Since the kernel's root cutover,
    // subscribe() asks the server whether the bound stream covers the pattern and
    // rejects `ready` (StreamCoverError, the server's own error, SetupTimeoutError)
    // when it never can — that verdict surfaces nowhere else. Awaiting it here is
    // what makes a dead consumer a boot failure instead of a process that runs
    // forever receiving nothing.
    await sub.ready
    // A subscription can also die LATER (its stream or consumer deleted under it).
    // `closed` carries that verdict within LIVENESS_FAULT_BOUND_MS. It is not
    // awaited — that would never return — so it is recorded as DEGRADED, which is
    // what puts it in the health body instead of only on stderr.
    void sub.closed.catch(async (err: unknown) => {
      console.error('[newsletter-audit-consumer] subscription died — resubscribe required:', err)
      _started = false
      // The restart calls back into `open()` and gets a NEW NatsBroker, so the
      // connection whose subscription just died has to be handed back HERE.
      // Round 3 dropped it: every StreamGone/ConsumerGone episode stranded one
      // live connection for the life of the process — the same leak the boot
      // path's `catch` was already fixed for.
      await broker.close().catch((closeErr: unknown) => {
        console.error('[newsletter-audit-consumer] closing the dead broker failed:', closeErr)
      })
      noteWorkerFault(NEWSLETTER_AUDIT_WORKER, err)
    })
  } catch (err) {
    await broker.close().catch(() => {})
    throw err
  }
  _started = true
  console.info('[newsletter-audit-consumer] started, subscribing', NEWSLETTER_CONSUMER_PATTERN)
}

/** Reset boot guard — for tests only. */
export function _resetStartedForTests(): void {
  _started = false
}
