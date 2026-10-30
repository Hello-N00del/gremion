// src/lib/server/governance/org-unit-event-relay.ts
//
// Drains the per-tenant org_unit_event_outbox and publishes to the broker
// (gremion.<tenantId>.org-unit.<event>). Stateless: register.server.ts calls
// runOrgUnitRelayPass() on a cadence.
//
// Subject + envelope rules:
//   subject     = orgUnitSubject(tenantId, row.event_type)  - the ONLY place the wire
//                 subject is built (the finance consumer subscribes STREAMS.ORGUNIT).
//   eventId     = row.event_id     - STABLE per outbox row (a retry re-publishes the
//                 SAME id, so the consumer's event_consumption dedups it: exactly-once apply).
//   occurredAt  = row.occurred_at  - the DML instant (NOT relay-publish time), so the
//                 consumer's per-aggregate ordering guard is driven by DML order.

import { orgUnitSubject, type BrokerPort, type EventEnvelope } from '@gremion/ports/broker'
import type { SqlRunner } from '$lib/server/db/tx'
import { drainOutbox, type OrgUnitOutboxRow } from './org-unit-event-outbox'

/** Run one relay pass for a tenant: drain due outbox rows, publish, mark ok/failed. */
export async function runOrgUnitRelayPass(
  sql: SqlRunner,
  tenantId: string,
  broker: BrokerPort,
  opts: { limit?: number } = {},
): Promise<{ ok: number; failed: number }> {
  return drainOutbox(
    sql,
    tenantId,
    async (row: OrgUnitOutboxRow) => {
      const subject = orgUnitSubject(tenantId, row.event_type)
      const envelope: EventEnvelope = {
        eventId: row.event_id,
        eventType: row.event_type,
        tenantId,
        occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
        correlationId: row.correlation_id,
        payload: row.payload,
      }
      await broker.publish(subject, envelope)
    },
    opts.limit,
  )
}
