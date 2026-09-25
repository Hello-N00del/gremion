/**
 * Integration tests for the A1 content-leaf scheduler keying fix.
 *
 * The scheduler's due-work MUST key off content.post_channels (enabled=true,
 * status='scheduled', scheduled_at<=now()) — the rows the per-channel arm path
 * (PATCH /posts/:id/channels/:channel) actually writes — NOT content.posts.status
 * (the whole-post claim lifecycle), which the arm path never touches. The old
 * keying read posts.status='scheduled', so a channel armed via the HTTP API was
 * NEVER dispatched (dead keying).
 *
 * Coverage:
 *   - arm a scheduled email channel via the leaf HTTP API → one dispatchDueChannels
 *     tick publishes it: post_channels.status advances email→'sent' + delivery row.
 *   - arm a scheduled portal channel → tick advances portal→'published' + publication.
 *   - REGRESSION: a post with ONLY posts.status='scheduled' and NO due post_channels
 *     row is NOT dispatched (proves the dead keying is gone).
 *   - IG-exclusion: a scheduled instagram channel is NOT picked up when
 *     resolveInstagramCredentials() is null (disabled-by-default seam).
 *
 * Fail-closed guard mirrors dispatch.integration.test.ts.
 */
import http from 'node:http'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { storeFor, _resetTenantStoreForTests, type TenantRef } from '../src/tenant-store.ts'
import { createServer } from '../src/http/server.ts'
import { buildApiRoutes } from '../src/http/routes.ts'
import {
  createPost,
  setPostChannelRecipients,
  createMailingList,
  addListMember,
  getChannelRow,
  getPublication,
  updatePost,
} from '../src/store/index.ts'
import { dispatchDueChannels } from '../src/scheduler.ts'
import { resolveInstagramCredentials } from '../src/instagram/credentials.ts'
import type { ChannelTransport } from '../src/dispatch.ts'
import type { KernelClient, Recipient } from '../src/kernel-client.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

// ── fail-closed guard ─────────────────────────────────────────────────────────
const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'content_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

const TENANT: TenantRef = { id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', slug: 'schedtest' }
const TEST_SECRET = 'test-content-sched-secret'

// ── fakes ───────────────────────────────────────────────────────────────────

function makeFakeEmailTransport(): ChannelTransport & { sent: Array<{ to: string }> } {
  const sent: Array<{ to: string }> = []
  let seq = 0
  return {
    sent,
    async send(msg: { to?: string }): Promise<{ id: string }> {
      sent.push({ to: msg.to ?? '' })
      seq += 1
      return { id: `<fake-${seq}@test>` }
    },
  }
}

function makeFakeKernel(): KernelClient {
  let portalSeq = 0
  return {
    async resolveGroup(): Promise<Recipient[]> {
      return []
    },
    async sendMail(): Promise<{ messageId: string }> {
      return { messageId: '<fake-kernel-mail@test>' }
    },
    async portalPublish(_postId, _title, _body, externalRef): Promise<{ news_posts_id: string }> {
      portalSeq += 1
      return { news_posts_id: externalRef ?? String(2000 + portalSeq) }
    },
  }
}

// ── PG lifecycle ──────────────────────────────────────────────────────────────
let admin: ReturnType<typeof postgres>
let sql: Awaited<ReturnType<typeof storeFor>>
let server: http.Server

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
  sql = await storeFor(TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })

  const routes = buildApiRoutes(async (t) => {
    if (t.id === TENANT.id) return sql
    throw new Error(`unknown test tenant: ${t.id}`)
  })
  server = createServer({ secret: TEST_SECRET, routes })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await _resetTenantStoreForTests()
  await dropTestDbs(admin)
  await admin.end()
})

beforeEach(async () => {
  await sql`DELETE FROM content.deliveries`
  await sql`DELETE FROM content.send_tokens`
  await sql`DELETE FROM content.post_recipients`
  await sql`DELETE FROM content.post_channels`
  await sql`DELETE FROM outbox`
  await sql`DELETE FROM content.publish_ops`
  await sql`DELETE FROM content.publications`
  await sql`DELETE FROM content.posts`
  await sql`DELETE FROM content.mailing_list_members`
  await sql`DELETE FROM content.mailing_lists`
})

// ── HTTP helper (arm channels via the real leaf API) ──────────────────────────

async function callServer(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server not listening')
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        method,
        path,
        headers: {
          'x-internal-auth': TEST_SECRET,
          'x-tenant-id': TENANT.id,
          'x-tenant-slug': TENANT.slug,
          'content-type': 'application/json',
          ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload).toString() } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8')
          let parsed: unknown
          try { parsed = JSON.parse(raw) } catch { parsed = raw }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      },
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

// ── helpers ───────────────────────────────────────────────────────────────────

const pastIso = (): string => new Date(Date.now() - 60_000).toISOString()

async function makePost(): Promise<string> {
  const post = await createPost(sql, {
    slug: `slug-${Math.random().toString(36).slice(2)}`,
    title: 'Scheduled Post',
    body_html: '<p>Body</p>',
    created_by: 'actor',
  })
  return post.id
}

/** Arm a channel via the REAL leaf HTTP API (PATCH), the way the kernel does. */
async function armChannelViaApi(
  postId: string,
  channel: 'email' | 'portal' | 'instagram',
  scheduledAt: string,
): Promise<void> {
  const res = await callServer('PATCH', `/api/v1/posts/${postId}/channels/${channel}`, {
    enabled: true,
    status: 'scheduled',
    scheduled_at: scheduledAt,
  })
  expect(res.status).toBe(200)
}

async function addEmailRecipients(postId: string, emails: string[]): Promise<void> {
  const list = await createMailingList(sql, 'List')
  for (const e of emails) await addListMember(sql, list.id, e, null, 'manual')
  await setPostChannelRecipients(sql, postId, 'email', [{ mailing_list_id: list.id }])
}

function dueDeps(overrides: Partial<Parameters<typeof dispatchDueChannels>[1]> = {}) {
  return {
    sql,
    kernel: makeFakeKernel(),
    emailTransport: makeFakeEmailTransport(),
    origin: 'https://a1.example',
    instagramConfigured: false,
    ...overrides,
  }
}

// ── A1: keying off post_channels ─────────────────────────────────────────────

describe('dispatchDueChannels — keys off due post_channels (A1)', () => {
  it('publishes an email channel armed as scheduled via the HTTP API (status→sent + delivery row)', async () => {
    const postId = await makePost()
    await addEmailRecipients(postId, ['alice@x.com'])
    await armChannelViaApi(postId, 'email', pastIso())

    const transport = makeFakeEmailTransport()
    await dispatchDueChannels(TENANT, dueDeps({ emailTransport: transport }))

    expect((await getChannelRow(sql, postId, 'email'))!.status).toBe('sent')
    expect(transport.sent.map((m) => m.to)).toEqual(['alice@x.com'])
    const dels = await sql<{ status: string }[]>`SELECT status FROM content.deliveries WHERE post_id = ${postId}`
    expect(dels).toHaveLength(1)
    expect(dels[0]!.status).toBe('sent')
  })

  it('publishes a portal channel armed as scheduled via the HTTP API (status→published + publication row)', async () => {
    const postId = await makePost()
    await armChannelViaApi(postId, 'portal', pastIso())

    await dispatchDueChannels(TENANT, dueDeps())

    expect((await getChannelRow(sql, postId, 'portal'))!.status).toBe('published')
    const pub = await getPublication(sql, postId, 'portal')
    expect(pub).not.toBeNull()
    expect(pub!.external_ref).toBeTruthy()
  })

  it('does NOT dispatch a channel whose scheduled_at is still in the future', async () => {
    const postId = await makePost()
    await armChannelViaApi(postId, 'portal', new Date(Date.now() + 3_600_000).toISOString())

    await dispatchDueChannels(TENANT, dueDeps())

    expect((await getChannelRow(sql, postId, 'portal'))!.status).toBe('scheduled')
    expect(await getPublication(sql, postId, 'portal')).toBeNull()
  })

  // REGRESSION: proves the dead keying (posts.status) is gone.
  it('does NOT dispatch a post that has ONLY posts.status=scheduled and NO due post_channels row', async () => {
    const postId = await makePost()
    // Mark the WHOLE-POST lifecycle scheduled + due, but arm NO channel.
    await updatePost(sql, postId, { status: 'scheduled', scheduled_at: pastIso() })

    await dispatchDueChannels(TENANT, dueDeps())

    // Nothing was published — no channel rows, deliveries, publications, or ops.
    const channels = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM content.post_channels WHERE post_id = ${postId}`
    expect(channels[0]!.c).toBe(0)
    const dels = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM content.deliveries WHERE post_id = ${postId}`
    expect(dels[0]!.c).toBe(0)
    const pubs = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM content.publications WHERE post_id = ${postId}`
    expect(pubs[0]!.c).toBe(0)
    const ops = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM content.publish_ops WHERE post_id = ${postId}`
    expect(ops[0]!.c).toBe(0)
  })
})

// ── A1: Instagram disabled-by-default exclusion ──────────────────────────────

describe('dispatchDueChannels — instagram disabled-by-default (A1)', () => {
  it('does NOT pick up a scheduled instagram channel when resolveInstagramCredentials() is null', async () => {
    // No IG env vars are set in this suite → the credential seam is null.
    expect(resolveInstagramCredentials()).toBeNull()

    const postId = await makePost()
    await armChannelViaApi(postId, 'instagram', pastIso())

    await dispatchDueChannels(TENANT, dueDeps({ instagramConfigured: resolveInstagramCredentials() != null }))

    const ops = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM content.publish_ops WHERE post_id = ${postId}`
    expect(ops[0]!.c).toBe(0)
    // The channel is left armed (still scheduled) — nothing consumed it.
    expect((await getChannelRow(sql, postId, 'instagram'))!.status).toBe('scheduled')
  })

  it('DOES enqueue a scheduled instagram channel when instagram IS configured (gate, not blanket skip)', async () => {
    const postId = await makePost()
    await armChannelViaApi(postId, 'instagram', pastIso())

    await dispatchDueChannels(TENANT, dueDeps({ instagramConfigured: true }))

    const ops = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM content.publish_ops WHERE post_id = ${postId}`
    expect(ops[0]!.c).toBe(1)
  })
})

// ── A1: scheduled-path outbox co-commit (correlated on postId) ───────────────
// The scheduled dispatch path (dispatchDueChannels → publishChannel) must
// co-commit EXACTLY ONE outbox row per successful channel publish, with the same
// event_type/payload the whole-post dispatch() emits, AND correlation_id === the
// postId — the scheduler's correlation anchor (there is no inbound HTTP
// x-correlation-id header for a scheduled tick). Mirrors the shapes asserted in
// publish-channel.integration.test.ts + the correlation_id lock in
// correlation-id.integration.test.ts.

describe('dispatchDueChannels — scheduled-path outbox co-commit (A1)', () => {
  it('a due scheduled email channel co-commits exactly one channel.email.sent outbox row correlated on postId', async () => {
    const postId = await makePost()
    await addEmailRecipients(postId, ['alice@x.com'])
    await armChannelViaApi(postId, 'email', pastIso())

    await dispatchDueChannels(TENANT, dueDeps({ emailTransport: makeFakeEmailTransport() }))

    const rows = await sql<{ event_type: string; payload: Record<string, unknown>; correlation_id: string | null }[]>`
      SELECT event_type, payload, correlation_id FROM outbox
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event_type).toBe('channel.email.sent')
    expect(rows[0]!.payload).toEqual({ postId, recipientCount: 1, deliveredCount: 1 })
    expect(rows[0]!.correlation_id).toBe(postId)
  })

  it('a due scheduled portal channel co-commits exactly one channel.portal.sent outbox row correlated on postId', async () => {
    const postId = await makePost()
    await armChannelViaApi(postId, 'portal', pastIso())

    await dispatchDueChannels(TENANT, dueDeps())

    const pub = await getPublication(sql, postId, 'portal')
    expect(pub).not.toBeNull()
    const rows = await sql<{ event_type: string; payload: Record<string, unknown>; correlation_id: string | null }[]>`
      SELECT event_type, payload, correlation_id FROM outbox
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event_type).toBe('channel.portal.sent')
    expect(rows[0]!.payload).toEqual({ postId, news_posts_id: pub!.external_ref })
    expect(rows[0]!.correlation_id).toBe(postId)
  })
})
