// services/calendar/src/relay.ts
//
// Relay loop: drains the per-tenant outbox → publishes to the broker.
//
// Subject construction rule (D-P1-7 verbatim):
//   subject = calendarSubject(tenantId, row.event_type as CalendarEvent)
//   where event_type is ALWAYS the short CalendarEvent value
//   ('event.created' | 'event.updated' | 'event.deleted' | 'caldav.sync.failed')
//   — never a calendar.-prefixed long form.
//
// The relay is stateless: callers (index.ts scheduler) call runRelayPass() on
// a cadence. A single pass drains all due outbox rows for the given tenant.
// Backoff and terminal logic live in outbox.ts (markOutboxFailed / GIVE_UP_AFTER_SECONDS).

import { makeEnvelope, calendarSubject, type BrokerPort, type CalendarEvent } from '@gremion/ports/broker'
import { noopTracer, type TracerPort } from '@gremion/ports/tracer'
import type { Sql } from './tenant-store.js'
import { drainOutbox, type OutboxRow } from './outbox.js'

export interface RelayOptions {
  /** Max rows to drain per pass (default 50). */
  limit?: number
  /**
   * T16 (D-P1-8): optional TracerPort for span emission.
   * When present, each published outbox row is wrapped in a
   * 'calendar.relay.publish' span carrying the row's correlation_id.
   * Defaults to noopTracer.
   */
  tracer?: TracerPort
}

/**
 * Run one relay pass for a tenant.
 *
 * For each due outbox row:
 *  1. Build the wire subject via calendarSubject() — the ONLY place the full
 *     subject is assembled (D-P1-7).
 *  2. Build an EventEnvelope via makeEnvelope().
 *  3. Publish via the broker.
 *  4. Mark ok (backoff reset) or failed (backoff increment) in the outbox.
 *
 * @param sql       postgres-js Sql bound to the tenant DB.
 * @param tenantId  The tenant id (used as the subject token).
 * @param broker    BrokerPort implementation (NatsBroker in prod, InMemoryBroker in tests).
 * @param opts      Optional overrides.
 */
export async function runRelayPass(
  sql: Sql,
  tenantId: string,
  broker: BrokerPort,
  opts: RelayOptions = {},
): Promise<{ ok: number; failed: number }> {
  return drainOutbox(
    sql,
    async (row: OutboxRow) => {
      // T16 (D-P1-8): wrap each publish in a calendar.relay.publish span.
      // Only emit spans when a tracer was explicitly injected; otherwise noop.
      const effectiveTracer = opts.tracer ?? noopTracer
      const span = effectiveTracer.startSpan('calendar.relay.publish', {
        eventType: row.event_type,
        tenant: tenantId,
      })
      try {
        const subject = calendarSubject(tenantId, row.event_type as CalendarEvent)
        const envelope = makeEnvelope({
          eventType: row.event_type,
          tenantId,
          correlationId: row.correlation_id,
          payload: row.payload,
        })
        await broker.publish(subject, envelope)
        span.end()
      } catch (err) {
        span.end(err)
        throw err
      }
    },
    opts.limit,
  )
}
