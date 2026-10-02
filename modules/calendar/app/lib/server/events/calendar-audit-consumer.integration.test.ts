// gremion-ui/src/lib/server/events/calendar-audit-consumer.integration.test.ts
//
// Task 10: TDD integration tests for the calendar audit consumer. Mirrors
// newsletter-audit-consumer.integration.test.ts file-for-file, swapped to the
// calendar subject grammar (gremion.*.calendar.>) and CalendarEvent type.
//
// All gates from the brief:
//   1. Same envelope delivered twice → ONE audit row (idempotency gate).
//   2. Two tenants' events each processed inside their own runWithTenant scope.
//   3. audit_log.correlation_id round-trips.
//   4. Tenant resolved by UUID (#173), not slug.
//
// Strategy: the InMemoryBroker (from @gremion/ports/broker) drives delivery
// because it honours the same subjectMatches semantics as NatsBroker (the '>'
// wildcard extension). The consumer is wired via wireCalendarAuditConsumer(),
// which subscribes to CALENDAR_CONSUMER_PATTERN ('gremion.*.calendar.>') —
// NEVER a test-only literal pattern.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { getDb } from '$lib/server/db'
import { getControlDb } from '$lib/server/tenant/control-db'
import { runControlMigrations } from '$lib/server/tenant/control-migrations'
import { registerDefaultTenant } from '$lib/server/tenant/register-default'
import {
  registerTenant,
  resolveTenantBySlug,
  getTenantBySlug,
  _resetResolutionCacheForTests,
} from '$lib/server/tenant/registry'
import { InMemoryBroker, makeEnvelope, calendarSubject } from '@gremion/ports/broker'
import {
  wireCalendarAuditConsumer,
  CALENDAR_CONSUMER_PATTERN,
  CALENDAR_AUDIT_CONSUMER,
} from './calendar-audit-consumer'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Publish an envelope on the correct calendar subject and wait one micro-task.
 *
 * `tenantId` is the tenant **UUID** — EXACTLY what the leaf publishes. The
 * consumer resolves the tenant via resolveTenantById(envelope.tenantId), so
 * the test MUST drive UUIDs, not slugs (#173).
 */
async function deliverEvent(
  broker: InMemoryBroker,
  tenantId: string,
  eventType: 'event.created' | 'event.updated' | 'event.deleted' | 'caldav.sync.failed',
  overrides: { correlationId?: string | null; eventId?: string; payload?: unknown } = {},
) {
  const envelope = makeEnvelope({
    eventType,
    tenantId,
    correlationId: overrides.correlationId ?? null,
    payload: overrides.payload ?? { eventDbId: 'evt-test-1' },
  })
  // Allow overriding the eventId for the duplicate-delivery test.
  const final = overrides.eventId ? { ...envelope, eventId: overrides.eventId } : envelope
  await broker.publish(calendarSubject(tenantId, eventType), final)
  // Let the async handler settle (Promise microtask queue).
  await new Promise((r) => setTimeout(r, 0))
  return final
}

/** Resolve a registered tenant's canonical UUID from its slug (control DB row). */
async function tenantId(slug: string): Promise<string> {
  const row = await getTenantBySlug(slug)
  if (!row) throw new Error(`test setup: tenant "${slug}" not registered`)
  return row.id
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('calendar-audit-consumer', () => {
  beforeAll(async () => {
    await runControlMigrations()
  })

  beforeEach(async () => {
    // Clean control plane.
    await getControlDb()`TRUNCATE tenant, tenant_provisioning_resource RESTART IDENTITY CASCADE`
    _resetResolutionCacheForTests()
    // Register the default tenant (points at DATABASE_URL = the integration DB).
    await registerDefaultTenant()

    // Clean data-plane tables used by these tests.
    const sql = getDb()
    await sql`TRUNCATE event_consumption RESTART IDENTITY`
    await sql`DELETE FROM audit_log WHERE field = 'calendar'`
  })

  afterEach(async () => {
    const sql = getDb()
    await sql`DELETE FROM audit_log WHERE field = 'calendar'`
    await sql`TRUNCATE event_consumption RESTART IDENTITY`
    await getControlDb()`TRUNCATE tenant, tenant_provisioning_resource RESTART IDENTITY CASCADE`
    _resetResolutionCacheForTests()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Gate 1 (TDD proof): idempotency — same eventId delivered twice → ONE row
  // ──────────────────────────────────────────────────────────────────────────

  it('same envelope delivered twice → ONE audit row (idempotency gate)', async () => {
    const broker = new InMemoryBroker()
    wireCalendarAuditConsumer(broker)

    const fixedEventId = 'c0ffee00-0000-0000-0000-000000000002'
    // The envelope carries the tenant UUID (what the leaf publishes), resolved by id.
    const defaultId = await tenantId('default')

    // First delivery.
    await deliverEvent(broker, defaultId, 'event.created', {
      eventId: fixedEventId,
      correlationId: 'corr-001',
    })

    // Second delivery — SAME eventId (simulate at-least-once re-delivery).
    await deliverEvent(broker, defaultId, 'event.created', {
      eventId: fixedEventId,
      correlationId: 'corr-001',
    })

    // Exactly ONE audit row despite two deliveries.
    const sql = getDb()
    const rows = await sql<{ id: bigint; field: string; correlation_id: string | null }[]>`
      SELECT id, field, correlation_id
      FROM audit_log
      WHERE field = 'calendar'
      ORDER BY id
    `
    expect(rows).toHaveLength(1)
    expect(rows[0].correlation_id).toBe('corr-001')

    // event_consumption has exactly one row for this eventId.
    const consumed = await sql<{ consumer: string }[]>`
      SELECT consumer FROM event_consumption
      WHERE event_id = ${fixedEventId}
    `
    expect(consumed).toHaveLength(1)
    expect(consumed[0].consumer).toBe(CALENDAR_AUDIT_CONSUMER)
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Gate 2: two tenants' events, each in their own runWithTenant scope
  // ──────────────────────────────────────────────────────────────────────────

  it('two tenants\' events land in their own data-plane scopes', async () => {
    // Register a second tenant pointing at the same integration DB.
    await registerTenant({
      slug: 'tenant-b',
      status: 'active',
      dbConnRef: 'env:DATABASE_URL',
      realmName: 'tenant-b',
      issuer: 'https://sturaos.com/auth/realms/tenant-b',
      kcInternal: 'http://keycloak:8080/auth/realms/tenant-b',
      kcClientId: 'stura-admin',
      kcClientRef: 'env:KEYCLOAK_ADMIN_CLIENT_SECRET',
      authClientRef: 'env:AUTH_KEYCLOAK_SECRET',
      ncTarget: {},
      matrixSpace: { aliasNamespace: 'b-' },
      domainProfile: {},
      brandRef: 'config:tenant-b',
      blueprintRef: 'STURA_BLUEPRINT@1',
      connProfile: { perTenantMax: 4, prepare: true },
      backupKeyRef: 'env:BACKUP_KEY',
      audiences: ['gremion-ui'],
    })

    // Sanity-check both tenants are resolvable (the consumer's registry lookup).
    const ctxA = await resolveTenantBySlug('default')
    const ctxB = await resolveTenantBySlug('tenant-b')
    expect(ctxA).not.toBeNull()
    expect(ctxB).not.toBeNull()

    const broker = new InMemoryBroker()
    wireCalendarAuditConsumer(broker)

    // Deliver one event for each tenant keyed by its UUID (the by-id resolve path).
    const envA = await deliverEvent(broker, ctxA!.id, 'event.created', { correlationId: 'corr-A' })
    const envB = await deliverEvent(broker, ctxB!.id, 'event.deleted', { correlationId: 'corr-B' })

    const sql = getDb()

    // Both audit rows written — the consumer entered runWithTenant for each.
    const rows = await sql<{ field: string; correlation_id: string | null }[]>`
      SELECT field, correlation_id
      FROM audit_log
      WHERE field = 'calendar'
      ORDER BY id
    `
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.correlation_id)).toEqual(expect.arrayContaining(['corr-A', 'corr-B']))

    // Both eventIds are in event_consumption.
    const consumed = await sql<{ event_id: string }[]>`
      SELECT event_id::text AS event_id
      FROM event_consumption
      WHERE consumer = ${CALENDAR_AUDIT_CONSUMER}
      ORDER BY consumed_at
    `
    const ids = consumed.map((r) => r.event_id)
    expect(ids).toContain(envA.eventId)
    expect(ids).toContain(envB.eventId)
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Gate 3: correlation_id round-trips
  // ──────────────────────────────────────────────────────────────────────────

  it('audit_log.correlation_id round-trips from the event envelope', async () => {
    const broker = new InMemoryBroker()
    wireCalendarAuditConsumer(broker)

    // Use a valid UUID so the value is consistent with correlation-id validation.
    const correlationId = 'e2e1c0ff-eeee-4abc-a123-000000000002'
    await deliverEvent(broker, await tenantId('default'), 'caldav.sync.failed', { correlationId })

    const sql = getDb()
    const rows = await sql<{ field: string; correlation_id: string | null }[]>`
      SELECT field, correlation_id
      FROM audit_log
      WHERE field = 'calendar'
    `
    expect(rows).toHaveLength(1)
    expect(rows[0].correlation_id).toBe(correlationId)
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Additional: unknown tenant → ack-skip, no audit row, no crash
  // ──────────────────────────────────────────────────────────────────────────

  it('unknown tenant → ack-skip without writing an audit row', async () => {
    const broker = new InMemoryBroker()
    wireCalendarAuditConsumer(broker)

    // A genuinely unknown tenant UUID (not registered in the control DB) →
    // resolveTenantById returns null → ack-skip, no audit row, no crash.
    const unknownId = 'deadbeef-0000-0000-0000-000000000001'
    const envelope = makeEnvelope({
      eventType: 'event.created',
      tenantId: unknownId,
      correlationId: null,
      payload: {},
    })
    await broker.publish(calendarSubject(unknownId, 'event.created'), envelope)
    await new Promise((r) => setTimeout(r, 0))

    const sql = getDb()
    const result = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log WHERE field = 'calendar'
    `
    expect(result[0].n).toBe(0)
  })

  // ──────────────────────────────────────────────────────────────────────────
  // #173: an envelope keyed by the tenant UUID resolves via the by-id path
  // ──────────────────────────────────────────────────────────────────────────

  it('UUID-keyed envelope resolves by id and writes one audit row', async () => {
    const broker = new InMemoryBroker()
    wireCalendarAuditConsumer(broker)

    const defaultId = await tenantId('default')
    // Prove the envelope key is a UUID (not a slug) — the exact shape the leaf publishes.
    expect(defaultId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

    await deliverEvent(broker, defaultId, 'event.updated', { correlationId: 'corr-byid' })

    const sql = getDb()
    const rows = await sql<{ correlation_id: string | null }[]>`
      SELECT correlation_id FROM audit_log WHERE field = 'calendar'
    `
    expect(rows).toHaveLength(1)
    expect(rows[0].correlation_id).toBe('corr-byid')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Pattern sanity: CALENDAR_CONSUMER_PATTERN matches calendarSubject() output
  // ──────────────────────────────────────────────────────────────────────────

  it('CALENDAR_CONSUMER_PATTERN matches the subjects built by calendarSubject()', async () => {
    // Wildcard parity: the SAME pattern the consumer uses is what the broker
    // delivers on. The '>' extension in InMemoryBroker.subjectMatches is the
    // reference semantics.
    const broker = new InMemoryBroker()
    const received: string[] = []
    broker.subscribe(CALENDAR_CONSUMER_PATTERN, async (_e, subject) => {
      received.push(subject)
    })

    await broker.publish(
      calendarSubject('default', 'event.created'),
      makeEnvelope({ eventType: 'event.created', tenantId: 'default', correlationId: null, payload: {} }),
    )
    await broker.publish(
      calendarSubject('tenant-x', 'caldav.sync.failed'),
      makeEnvelope({ eventType: 'caldav.sync.failed', tenantId: 'tenant-x', correlationId: null, payload: {} }),
    )
    await new Promise((r) => setTimeout(r, 0))

    // Built by the same helper the publish side used, never restated: the
    // point of this assertion is that CONSUMER_PATTERN covers what the helper
    // emits, and a literal subject would silently pin the wire root too.
    expect(received).toEqual([
      calendarSubject('default', 'event.created'),
      calendarSubject('tenant-x', 'caldav.sync.failed'),
    ])
  })
})
