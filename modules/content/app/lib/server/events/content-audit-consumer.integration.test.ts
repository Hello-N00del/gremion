// gremion-ui/src/lib/server/events/content-audit-consumer.integration.test.ts
//
// Task 12: TDD integration tests for the content audit consumer.
//
// All three gates from the brief:
//   1. Same envelope delivered twice → ONE audit row (idempotency gate).
//   2. Two tenants' events each processed inside their own runWithTenant scope.
//   3. audit_log.correlation_id round-trips.
//
// Strategy: the InMemoryBroker (from @gremion/ports/broker) drives delivery
// because it honours the same subjectMatches semantics as NatsBroker (the '>'
// extension added in Task 2 / D-P1-7). The consumer is wired via
// wireContentAuditConsumer(), which subscribes to CONTENT_CONSUMER_PATTERN
// ('gremion.*.content.>') — NEVER a test-only literal pattern.
//
// Two-tenant setup: both tenants point at the same test DB (one PG instance in
// this harness). We prove the consumer resolves and enters runWithTenant for
// BOTH tenants separately, each producing the correct audit row.
//
// Tenant resolution: envelopes carry the tenant UUID (not slug) — exactly what
// the content relay publishes — so the consumer resolves via resolveTenantById.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { getDb } from '$lib/server/db'
import { getControlDb } from '$lib/server/tenant/control-db'
import { runControlMigrations } from '$lib/server/tenant/control-migrations'
import { createTestTenant } from '../../../../tests/integration/create-test-tenant'
import {
  registerTenant,
  resolveTenantBySlug,
  getTenantBySlug,
  _resetResolutionCacheForTests,
} from '$lib/server/tenant/registry'
import { InMemoryBroker, makeEnvelope, contentSubject } from '@gremion/ports/broker'
import type { ContentEvent } from '@gremion/ports/broker'
import {
  wireContentAuditConsumer,
  CONTENT_CONSUMER_PATTERN,
  CONTENT_AUDIT_CONSUMER,
} from './content-audit-consumer'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Publish an envelope on the correct content subject and wait one micro-task.
 *
 * `tenantId` is the tenant **UUID** — EXACTLY what the content relay publishes:
 * relay.ts builds BOTH the subject token and `envelope.tenantId` from the same
 * `tenant.id` (a UUID, which is one dot-free subject token, so
 * `gremion.<uuid>.content.<event>` matches `gremion.*.content.>`). The
 * consumer resolves the tenant via resolveTenantById(envelope.tenantId), so the
 * test MUST drive UUIDs, not slugs.
 */
async function deliverEvent(
  broker: InMemoryBroker,
  tenantId: string,
  eventType: ContentEvent,
  overrides: { correlationId?: string | null; eventId?: string } = {},
) {
  const envelope = makeEnvelope({
    eventType,
    tenantId,
    correlationId: overrides.correlationId ?? null,
    payload: { contentPostId: 'post-test-1', channelType: 'portal' },
  })
  // Allow overriding the eventId for the duplicate-delivery test.
  const final = overrides.eventId ? { ...envelope, eventId: overrides.eventId } : envelope
  await broker.publish(contentSubject(tenantId, eventType), final)
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

describe('content-audit-consumer', () => {
  beforeAll(async () => {
    await runControlMigrations()
  })

  beforeEach(async () => {
    // Clean control plane.
    await getControlDb()`TRUNCATE tenant, tenant_provisioning_resource RESTART IDENTITY CASCADE`
    _resetResolutionCacheForTests()
    // TASK-042: no default tenant exists; the suite registers its own first tenant (data plane = the
    // integration DB, DATABASE_URL).
    await createTestTenant({ slug: 'tenant-a', host: 'tenant-a.test' })

    // Clean data-plane tables used by these tests.
    const sql = getDb()
    await sql`TRUNCATE event_consumption RESTART IDENTITY`
    await sql`DELETE FROM audit_log WHERE field IN ('content_published', 'content_publish_failed', 'content_channel_email_sent', 'content_channel_portal_sent', 'content_channel_instagram_enqueued')`
  })

  afterEach(async () => {
    const sql = getDb()
    await sql`DELETE FROM audit_log WHERE field IN ('content_published', 'content_publish_failed', 'content_channel_email_sent', 'content_channel_portal_sent', 'content_channel_instagram_enqueued')`
    await sql`TRUNCATE event_consumption RESTART IDENTITY`
    await getControlDb()`TRUNCATE tenant, tenant_provisioning_resource RESTART IDENTITY CASCADE`
    _resetResolutionCacheForTests()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Gate 1 (TDD proof): idempotency — same envelope delivered twice → ONE row
  // ──────────────────────────────────────────────────────────────────────────

  it('same envelope delivered twice → ONE audit row (idempotency gate)', async () => {
    const broker = new InMemoryBroker()
    wireContentAuditConsumer(broker)

    const fixedEventId = 'c0ffee00-0000-0000-0000-000000000002'
    // The envelope carries the tenant UUID (what the leaf publishes), resolved by id.
    const defaultId = await tenantId('tenant-a')

    // First delivery.
    await deliverEvent(broker, defaultId, 'publish.succeeded', {
      eventId: fixedEventId,
      correlationId: 'corr-001',
    })

    // Second delivery — SAME eventId (simulate at-least-once re-delivery).
    await deliverEvent(broker, defaultId, 'publish.succeeded', {
      eventId: fixedEventId,
      correlationId: 'corr-001',
    })

    // Exactly ONE audit row despite two deliveries.
    const sql = getDb()
    const rows = await sql<{ id: bigint; field: string; correlation_id: string | null }[]>`
      SELECT id, field, correlation_id
      FROM audit_log
      WHERE field = 'content_published'
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
    expect(consumed[0].consumer).toBe(CONTENT_AUDIT_CONSUMER)
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Gate 2: two tenants' events, each in their own runWithTenant scope
  // ──────────────────────────────────────────────────────────────────────────

  it("two tenants' events land in their own data-plane scopes", async () => {
    // Register a second tenant pointing at the same integration DB.
    await registerTenant({
      slug: 'tenant-b',
      status: 'active',
      dbConnRef: 'env:DATABASE_URL',
      realmName: 'tenant-b',
      issuer: 'https://tenant-b.test/auth/realms/tenant-b',
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
    const ctxA = await resolveTenantBySlug('tenant-a')
    const ctxB = await resolveTenantBySlug('tenant-b')
    expect(ctxA).not.toBeNull()
    expect(ctxB).not.toBeNull()

    const broker = new InMemoryBroker()
    wireContentAuditConsumer(broker)

    // Deliver one event for each tenant keyed by its UUID (the by-id resolve path).
    const envA = await deliverEvent(broker, ctxA!.id, 'publish.succeeded', { correlationId: 'corr-A' })
    const envB = await deliverEvent(broker, ctxB!.id, 'publish.failed', { correlationId: 'corr-B' })

    const sql = getDb()

    // Both audit rows written — the consumer entered runWithTenant for each.
    const rows = await sql<{ field: string; correlation_id: string | null }[]>`
      SELECT field, correlation_id
      FROM audit_log
      WHERE field IN ('content_published', 'content_publish_failed')
      ORDER BY id
    `
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.field === 'content_published')?.correlation_id).toBe('corr-A')
    expect(rows.find((r) => r.field === 'content_publish_failed')?.correlation_id).toBe('corr-B')

    // Both eventIds are in event_consumption.
    const consumed = await sql<{ event_id: string }[]>`
      SELECT event_id::text AS event_id
      FROM event_consumption
      WHERE consumer = ${CONTENT_AUDIT_CONSUMER}
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
    wireContentAuditConsumer(broker)

    const correlationId = 'e2e1c0ff-eeee-4abc-a123-000000000002'
    await deliverEvent(broker, await tenantId('tenant-a'), 'publish.failed', { correlationId })

    const sql = getDb()
    const rows = await sql<{ field: string; correlation_id: string | null }[]>`
      SELECT field, correlation_id
      FROM audit_log
      WHERE field = 'content_publish_failed'
    `
    expect(rows).toHaveLength(1)
    expect(rows[0].correlation_id).toBe(correlationId)
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Additional: unknown tenant → ack-skip, no audit row, no crash
  // ──────────────────────────────────────────────────────────────────────────

  it('unknown tenant → ack-skip without writing an audit row', async () => {
    const broker = new InMemoryBroker()
    wireContentAuditConsumer(broker)

    // A genuinely unknown tenant UUID (not registered in the control DB) →
    // resolveTenantById returns null → ack-skip, no audit row, no crash.
    const unknownId = 'deadbeef-0000-0000-0000-000000000001'
    const envelope = makeEnvelope({
      eventType: 'publish.succeeded',
      tenantId: unknownId,
      correlationId: null,
      payload: {},
    })
    await broker.publish(contentSubject(unknownId, 'publish.succeeded'), envelope)
    await new Promise((r) => setTimeout(r, 0))

    const sql = getDb()
    const result = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log WHERE field = 'content_published'
    `
    expect(result[0].n).toBe(0)
  })

  // ──────────────────────────────────────────────────────────────────────────
  // UUID-keyed envelope resolves by id and writes exactly ONE audit row
  // ──────────────────────────────────────────────────────────────────────────

  it('UUID-keyed envelope resolves by id and writes one audit row', async () => {
    const broker = new InMemoryBroker()
    wireContentAuditConsumer(broker)

    const defaultId = await tenantId('tenant-a')
    // Prove the envelope key is a UUID (not a slug) — the exact shape the leaf publishes.
    expect(defaultId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

    await deliverEvent(broker, defaultId, 'publish.succeeded', { correlationId: 'corr-byid' })

    const sql = getDb()
    const rows = await sql<{ correlation_id: string | null }[]>`
      SELECT correlation_id FROM audit_log WHERE field = 'content_published'
    `
    expect(rows).toHaveLength(1)
    expect(rows[0].correlation_id).toBe('corr-byid')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Pattern sanity: CONTENT_CONSUMER_PATTERN matches contentSubject() output
  // ──────────────────────────────────────────────────────────────────────────

  it('CONTENT_CONSUMER_PATTERN matches the subjects built by contentSubject()', async () => {
    // Wildcard parity (D-P1-7): the SAME pattern the consumer uses is what the
    // broker delivers on. The '>' extension in InMemoryBroker.subjectMatches is
    // the reference semantics.
    const broker = new InMemoryBroker()
    const received: string[] = []
    broker.subscribe(CONTENT_CONSUMER_PATTERN, async (_e, subject) => {
      received.push(subject)
    })

    await broker.publish(
      contentSubject('no-such-tenant', 'publish.succeeded'),
      makeEnvelope({ eventType: 'publish.succeeded', tenantId: 'no-such-tenant', correlationId: null, payload: {} }),
    )
    await broker.publish(
      contentSubject('tenant-x', 'channel.portal.sent'),
      makeEnvelope({ eventType: 'channel.portal.sent', tenantId: 'tenant-x', correlationId: null, payload: {} }),
    )
    await new Promise((r) => setTimeout(r, 0))

    // Built by the same helper the publish side used, never restated: the
    // point of this assertion is that CONSUMER_PATTERN covers what the helper
    // emits, and a literal subject would silently pin the wire root too.
    expect(received).toEqual([
      contentSubject('no-such-tenant', 'publish.succeeded'),
      contentSubject('tenant-x', 'channel.portal.sent'),
    ])
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Migration 040 sanity: event_consumption table exists (shared with newsletter)
  // ──────────────────────────────────────────────────────────────────────────

  it('migration 040: event_consumption table exists with correct columns', async () => {
    const sql = getDb()
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'event_consumption'
      ORDER BY column_name
    `
    const names = cols.map((c) => c.column_name)
    expect(names).toContain('consumer')
    expect(names).toContain('event_id')
    expect(names).toContain('consumed_at')
  })
})
