/**
 * T16 — Correlation-id wiring integration test (leaf side).
 *
 * Proves: a leaf dispatch with an injected correlation-id results in:
 *   1. The outbox row carrying the SAME correlation_id.
 *   2. The relay envelope carrying the SAME correlation_id.
 *
 * The monolith side (audit_log.correlation_id) is proven by the existing
 * gremion-ui newsletter-audit-consumer.integration.test.ts Gate 3 test.
 *
 * End-to-end chain asserted here:
 *   injectedCorrelationId
 *     → outbox.correlation_id  (dispatch → enqueueOutbox)
 *     → envelope.correlationId  (relay → makeEnvelope)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { storeFor, _resetTenantStoreForTests, type TenantRef } from '../src/tenant-store.ts'
import {
  createNewsletter,
  setNewsletterRecipients,
  createMailingList,
  addMember,
} from '../src/store/index.ts'
import { dispatch, type MailTransport, type SentMessage } from '../src/dispatch.ts'
import type { KernelClient } from '../src/kernel-client.ts'
import { runRelayPass } from '../src/relay.ts'
import { InMemoryBroker, STREAMS, type EventEnvelope } from '@gremion/ports/broker'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

// ── fail-closed guard ─────────────────────────────────────────────────────────
const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'newsletter_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

const CORR_TENANT: TenantRef = {
  id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  slug: 'corrtest',
}
const ACTOR = 'corr-test-actor'

// ── fakes ─────────────────────────────────────────────────────────────────────
function makeFakeTransport(): MailTransport {
  return {
    async sendMail(msg): Promise<SentMessage> {
      return { messageId: `<fake-corr-${msg.to}@test>` }
    },
  }
}

function makeFakeKernel(): KernelClient {
  return {
    async render(): Promise<string> { return '<html><body>Test</body></html>' },
    async resolveGroup(): Promise<{ email: string; name: string | null }[]> { return [] },
    async sendMail(msg): Promise<{ messageId: string }> { return { messageId: `<k-${msg.to}@test>` } },
  }
}

// ── PG lifecycle ──────────────────────────────────────────────────────────────
let admin: ReturnType<typeof postgres>
let sql: Awaited<ReturnType<typeof storeFor>>

async function dropTestDbs(pgSql: ReturnType<typeof postgres>): Promise<void> {
  const rows = await pgSql<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname LIKE 'newsletter_test_%'
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
  sql = await storeFor(CORR_TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
})

afterAll(async () => {
  await _resetTenantStoreForTests()
  await dropTestDbs(admin)
  await admin.end()
})

beforeEach(async () => {
  await sql`DELETE FROM deliveries`
  await sql`DELETE FROM outbox`
  await sql`DELETE FROM send_tokens`
  await sql`DELETE FROM newsletter_recipients`
  await sql`DELETE FROM newsletters`
  await sql`DELETE FROM mailing_list_members`
  await sql`DELETE FROM mailing_lists`
})

// ── helpers ───────────────────────────────────────────────────────────────────
async function makeNewsletterWithMember(email: string): Promise<number> {
  const nl = await createNewsletter(sql, {
    title: 'Corr NL', odt_path: '/c.odt', subject: 'Corr Subject', created_by: ACTOR,
  })
  const list = await createMailingList(sql, 'Corr List')
  await addMember(sql, list.id, email, null, 'manual')
  await setNewsletterRecipients(sql, nl.id, [{ mailing_list_id: list.id }])
  return nl.id
}

// ── T16 end-to-end proof ───────────────────────────────────────────────────────
describe('T16 — correlation-id wiring: dispatch → outbox → relay envelope', () => {
  it('injected correlationId propagates through outbox row and relay envelope (all three equal)', async () => {
    // A valid UUID to inject (as if it came from the HTTP x-correlation-id header).
    const injectedCorrelationId = '12345678-1234-4321-abcd-000000000001'
    const nlId = await makeNewsletterWithMember('alice@corr.test')

    // 1. Dispatch with injected correlationId.
    await dispatch(CORR_TENANT, nlId, ACTOR, {
      sql,
      kernel: makeFakeKernel(),
      transport: makeFakeTransport(),
      origin: 'https://corrtest.example',
      correlationId: injectedCorrelationId,
    })

    // 2. Assert outbox row carries the injected correlationId.
    const outboxRows = await sql<{ correlation_id: string | null; event_type: string }[]>`
      SELECT correlation_id, event_type FROM outbox ORDER BY created_at
    `
    expect(outboxRows).toHaveLength(1)
    expect(outboxRows[0]!.event_type).toBe('send.succeeded')
    // PROOF 1: outbox.correlation_id === injectedCorrelationId
    expect(outboxRows[0]!.correlation_id).toBe(injectedCorrelationId)

    // 3. Run relay pass → capture the published envelope via InMemoryBroker.
    const broker = new InMemoryBroker()
    const received: EventEnvelope[] = []
    broker.subscribe(STREAMS.NEWSLETTER.subjects[0]!, async (envelope) => {
      received.push(envelope)
    })

    await runRelayPass(sql, CORR_TENANT.slug, broker)

    // 4. Assert the relay envelope carries the same correlationId.
    expect(received).toHaveLength(1)
    // PROOF 2: envelope.correlationId === injectedCorrelationId
    expect(received[0]!.correlationId).toBe(injectedCorrelationId)

    // 5. Transitivity: outbox.correlation_id === envelope.correlationId
    expect(outboxRows[0]!.correlation_id).toBe(received[0]!.correlationId)
  })
})
