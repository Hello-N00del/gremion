/**
 * T18 — Correlation-id wiring integration test (content leaf side).
 *
 * Mirrors services/newsletter/test/correlation-id.integration.test.ts.
 *
 * Proves: a leaf dispatch with an injected correlation-id results in:
 *   1. The outbox row carrying the SAME correlation_id.
 *   2. The relay envelope carrying the SAME correlation_id.
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
  createPost,
  createMailingList,
  addListMember,
  setPostChannelRecipients,
} from '../src/store/index.ts'
import { dispatch, type ChannelTransport } from '../src/dispatch.ts'
import type { KernelClient } from '../src/kernel-client.ts'
import { runRelayPass } from '../src/relay.ts'
import { InMemoryBroker, STREAMS, type EventEnvelope } from '@gremion/ports/broker'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

// ── fail-closed guard ─────────────────────────────────────────────────────────
const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'content_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

const CORR_TENANT: TenantRef = {
  id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  slug: 'corrtest',
}
const ACTOR = 'corr-test-actor'

// ── fakes ─────────────────────────────────────────────────────────────────────
function makeFakeEmailTransport(): ChannelTransport {
  return {
    async send(msg: { to: string; subject: string; html: string }): Promise<{ id: string }> {
      return { id: `<fake-corr-${msg.to}@test>` }
    },
  }
}

function makeFakeKernel(): KernelClient {
  return {
    async resolveGroup(): Promise<{ email: string; name: string | null }[]> { return [] },
    async sendMail(): Promise<{ messageId: string }> { return { messageId: '<k@test>' } },
    async portalPublish(): Promise<{ news_posts_id: string }> { return { news_posts_id: '1' } },
  }
}

// ── PG lifecycle ──────────────────────────────────────────────────────────────
let admin: ReturnType<typeof postgres>
let sql: Awaited<ReturnType<typeof storeFor>>

async function dropTestDbs(pgSql: ReturnType<typeof postgres>): Promise<void> {
  const rows = await pgSql<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname LIKE 'content_test_%'
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
  await sql`DELETE FROM content.deliveries`
  await sql`DELETE FROM outbox`
  await sql`DELETE FROM content.send_tokens`
  await sql`DELETE FROM content.post_recipients`
  await sql`DELETE FROM content.posts`
  await sql`DELETE FROM content.mailing_list_members`
  await sql`DELETE FROM content.mailing_lists`
})

// ── T18 end-to-end proof ───────────────────────────────────────────────────────
describe('T18 — correlation-id wiring: dispatch → outbox → relay envelope', () => {
  it('injected correlationId propagates through outbox row and relay envelope (all three equal)', async () => {
    const injectedCorrelationId = '12345678-1234-4321-abcd-000000000099'

    const post = await createPost(sql, {
      slug: `slug-${Math.random().toString(36).slice(2)}`,
      title: 'Corr Post', body_html: '<p>Test</p>', created_by: ACTOR,
    })
    const list = await createMailingList(sql, 'Corr List')
    await addListMember(sql, list.id, 'alice@corr.test', null, 'manual')
    await setPostChannelRecipients(sql, post.id, 'email', [{ mailing_list_id: list.id }])

    // 1. Dispatch with injected correlationId.
    await dispatch(CORR_TENANT, post.id, ACTOR, {
      sql,
      kernel: makeFakeKernel(),
      channels: new Map<'email' | 'portal' | 'instagram', ChannelTransport>([
        ['email', makeFakeEmailTransport()],
      ]),
      origin: 'https://corrtest.example',
      correlationId: injectedCorrelationId,
    })

    // 2. Assert outbox rows carry the injected correlationId.
    const outboxRows = await sql<{ correlation_id: string | null; event_type: string }[]>`
      SELECT correlation_id, event_type FROM outbox ORDER BY created_at
    `
    expect(outboxRows.length).toBeGreaterThan(0)
    // PROOF 1: every outbox.correlation_id === injectedCorrelationId
    for (const row of outboxRows) {
      expect(row.correlation_id).toBe(injectedCorrelationId)
    }

    // Get the publish.succeeded row to verify relay envelope.
    const succeededRow = outboxRows.find((r) => r.event_type === 'publish.succeeded')
    expect(succeededRow).not.toBeUndefined()

    // 3. Run relay pass → capture the published envelope via InMemoryBroker.
    const broker = new InMemoryBroker()
    const received: EventEnvelope[] = []
    broker.subscribe(STREAMS.CONTENT.subjects[0]!, async (envelope) => {
      received.push(envelope)
    })

    await runRelayPass(sql, CORR_TENANT.id, broker)

    // 4. Assert the relay envelopes carry the same correlationId.
    expect(received.length).toBeGreaterThan(0)
    // PROOF 2: envelope.correlationId === injectedCorrelationId
    for (const envelope of received) {
      expect(envelope.correlationId).toBe(injectedCorrelationId)
    }

    // 5. Transitivity check: outbox and envelope agree.
    expect(succeededRow!.correlation_id).toBe(received[0]!.correlationId)
  })
})
