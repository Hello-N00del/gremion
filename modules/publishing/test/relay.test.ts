/**
 * Unit tests for services/newsletter/src/relay.ts
 *
 * Uses InMemoryBroker (the reference BrokerPort double) — no real NATS needed.
 * Uses a real PG via NEWSLETTER_TEST_PG_URL (same fail-closed guard as the other
 * integration tests) to exercise the full outbox → relay pipeline.
 *
 * Covers:
 *  - runRelayPass: publishes envelopes with the correct subject (= newsletterSubject())
 *  - subject is NEVER hand-concatenated; relay uses newsletterSubject() exclusively
 *  - envelope.tenantId matches the relay tenantId
 *  - envelope.correlationId propagated from outbox row
 *  - wildcard-parity via InMemoryBroker: gremion.*.newsletter.> receives the relay subject
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { storeFor, _resetTenantStoreForTests, type TenantRef } from '../src/tenant-store.ts'
import { enqueueOutbox } from '../src/outbox.ts'
import { runRelayPass } from '../src/relay.ts'
import { InMemoryBroker, newsletterSubject, STREAMS } from '@gremion/ports/broker'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

// ── fail-closed guard ─────────────────────────────────────────────────────────
const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'newsletter_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

// ── test tenant ───────────────────────────────────────────────────────────────
const RELAY_TENANT: TenantRef = {
  id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  slug: 'relaytest',
}
const TENANT_ID = RELAY_TENANT.id

// ── helpers ───────────────────────────────────────────────────────────────────
let admin: ReturnType<typeof postgres>
let sql: Awaited<ReturnType<typeof storeFor>>

async function dropTestDbs(pgSql: ReturnType<typeof postgres>): Promise<void> {
  const rows = await pgSql<{ datname: string }[]>`
    SELECT datname FROM pg_database
    WHERE datname LIKE 'newsletter_test_%'
  `
  for (const { datname } of rows) {
    await pgSql.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${datname}' AND pid <> pg_backend_pid()`,
    )
    await pgSql.unsafe(`DROP DATABASE IF EXISTS "${datname}"`)
  }
}

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 1, prepare: false })
  await dropTestDbs(admin)
  sql = await storeFor(RELAY_TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
})

afterAll(async () => {
  await _resetTenantStoreForTests()
  await dropTestDbs(admin)
  await admin.end()
})

beforeEach(async () => {
  await sql`DELETE FROM outbox`
})

// ── relay: subject construction (D-P1-7) ──────────────────────────────────────
describe('runRelayPass — subject construction', () => {
  it('publishes to the exact subject produced by newsletterSubject()', async () => {
    const broker = new InMemoryBroker()
    await sql.begin(async (tx) => {
      await enqueueOutbox(tx as never, 'send.succeeded', { newsletterId: 99 }, 'corr-sub-test')
    })

    await runRelayPass(sql, TENANT_ID, broker)

    expect(broker.published).toHaveLength(1)
    const { subject } = broker.published[0]!
    const expected = newsletterSubject(TENANT_ID, 'send.succeeded')
    expect(subject).toBe(expected)
    // Must be the 5-token form.
    expect(subject.split('.').length).toBe(5)
    // Must NOT double-prefix (no gremion.*.newsletter.newsletter.*)
    expect(subject).not.toContain('newsletter.newsletter')
  })

  it('publishes to the correct subject for send.failed event type', async () => {
    const broker = new InMemoryBroker()
    await sql.begin(async (tx) => {
      await enqueueOutbox(tx as never, 'send.failed', { reason: 'smtp' })
    })

    await runRelayPass(sql, TENANT_ID, broker)

    expect(broker.published).toHaveLength(1)
    const expected = newsletterSubject(TENANT_ID, 'send.failed')
    expect(broker.published[0]!.subject).toBe(expected)
  })
})

// ── relay: envelope fields ────────────────────────────────────────────────────
describe('runRelayPass — envelope fields', () => {
  it('envelope.tenantId equals the relay tenantId', async () => {
    const broker = new InMemoryBroker()
    await sql.begin(async (tx) => {
      await enqueueOutbox(tx as never, 'send.succeeded', {})
    })

    await runRelayPass(sql, TENANT_ID, broker)

    expect(broker.published[0]!.event.tenantId).toBe(TENANT_ID)
  })

  it('envelope.correlationId propagated from outbox row', async () => {
    const broker = new InMemoryBroker()
    await sql.begin(async (tx) => {
      await enqueueOutbox(tx as never, 'send.succeeded', {}, 'my-correlation-id')
    })

    await runRelayPass(sql, TENANT_ID, broker)

    expect(broker.published[0]!.event.correlationId).toBe('my-correlation-id')
  })

  it('envelope.correlationId is null when not set in outbox row', async () => {
    const broker = new InMemoryBroker()
    await sql.begin(async (tx) => {
      await enqueueOutbox(tx as never, 'send.succeeded', {})
    })

    await runRelayPass(sql, TENANT_ID, broker)

    expect(broker.published[0]!.event.correlationId).toBeNull()
  })

  it('envelope.eventType matches the outbox row event_type', async () => {
    const broker = new InMemoryBroker()
    await sql.begin(async (tx) => {
      await enqueueOutbox(tx as never, 'send.failed', { reason: 'test' })
    })

    await runRelayPass(sql, TENANT_ID, broker)

    expect(broker.published[0]!.event.eventType).toBe('send.failed')
  })

  it('envelope has a valid eventId (uuid format)', async () => {
    const broker = new InMemoryBroker()
    await sql.begin(async (tx) => {
      await enqueueOutbox(tx as never, 'send.succeeded', {})
    })

    await runRelayPass(sql, TENANT_ID, broker)

    expect(broker.published[0]!.event.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
  })
})

// ── relay: multiple rows ──────────────────────────────────────────────────────
describe('runRelayPass — multiple rows', () => {
  it('drains all due rows in one pass', async () => {
    const broker = new InMemoryBroker()
    await sql.begin(async (tx) => {
      await enqueueOutbox(tx as never, 'send.succeeded', { a: 1 })
      await enqueueOutbox(tx as never, 'send.failed', { b: 2 })
    })

    const result = await runRelayPass(sql, TENANT_ID, broker)

    expect(result.ok).toBe(2)
    expect(result.failed).toBe(0)
    expect(broker.published).toHaveLength(2)
  })

  it('returns {ok:0, failed:0} when no rows are due', async () => {
    const broker = new InMemoryBroker()
    const result = await runRelayPass(sql, TENANT_ID, broker)
    expect(result).toEqual({ ok: 0, failed: 0 })
    expect(broker.published).toHaveLength(0)
  })
})

// ── wildcard-parity via InMemoryBroker ────────────────────────────────────────
describe('wildcard-parity: relay subject received by gremion.*.newsletter.> subscriber', () => {
  it('subscriber with gremion.*.newsletter.> receives the relay-published subject', async () => {
    const broker = new InMemoryBroker()
    const received: string[] = []

    broker.subscribe(STREAMS.NEWSLETTER.subjects[0]!, async (_, subj) => {
      received.push(subj)
    })

    await sql.begin(async (tx) => {
      await enqueueOutbox(tx as never, 'send.succeeded', {})
      await enqueueOutbox(tx as never, 'send.failed', {})
    })

    await runRelayPass(sql, TENANT_ID, broker)

    expect(received).toHaveLength(2)
    expect(received).toContain(newsletterSubject(TENANT_ID, 'send.succeeded'))
    expect(received).toContain(newsletterSubject(TENANT_ID, 'send.failed'))
  })
})
