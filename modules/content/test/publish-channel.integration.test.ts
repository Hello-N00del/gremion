/**
 * Integration tests for publishChannel — the SYNCHRONOUS per-channel publish
 * that backs the leaf's POST /api/v1/posts/:id/publish/:channel endpoint (the
 * service-mode counterpart of the kernel's publishPost).
 *
 * Mirrors dispatch.integration.test.ts's PG lifecycle + fakes, but asserts the
 * PER-CHANNEL PublishResult contract + per-channel post_channels.status advance
 * (NOT the whole-post posts.status / outbox path that dispatch() drives).
 *
 * Fail-closed guard mirrors dispatch.integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { storeFor, _resetTenantStoreForTests, type TenantRef } from '../src/tenant-store.ts'
import {
  createPost,
  setPostChannelRecipients,
  createMailingList,
  addListMember,
  getPublication,
  getChannelRow,
} from '../src/store/index.ts'
import { publishChannel, ChannelNotPublishableError } from '../src/publish-channel.ts'
import type { ChannelTransport } from '../src/dispatch.ts'
import { MailUnconfiguredError, type KernelClient, type Recipient } from '../src/kernel-client.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

// ── fail-closed guard ─────────────────────────────────────────────────────────
const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'content_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

const TENANT: TenantRef = {
  id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  slug: 'pubchantest',
}

// ── fakes ───────────────────────────────────────────────────────────────────

function makeFakeEmailTransport(
  opts: { failFor?: Set<string>; mailUnconfigured?: boolean } = {},
): ChannelTransport & { sent: Array<{ to: string }>; countFor(email: string): number } {
  const sent: Array<{ to: string; subject: string; html: string }> = []
  let seq = 0
  return {
    sent,
    countFor(email: string): number {
      return sent.filter((m) => m.to === email).length
    },
    async send(msg: { to?: string; subject?: string; html?: string }): Promise<{ id: string }> {
      if (opts.mailUnconfigured) throw new MailUnconfiguredError()
      if (opts.failFor?.has(msg.to ?? '')) throw new Error(`fake SMTP failure for ${msg.to}`)
      sent.push({ to: msg.to ?? '', subject: msg.subject ?? '', html: msg.html ?? '' })
      seq += 1
      return { id: `<fake-${seq}@test>` }
    },
  }
}

function makeFakeKernel(
  opts: { groups?: Record<string, Recipient[]>; portalCalls?: string[] } = {},
): KernelClient {
  let portalSeq = 0
  return {
    async resolveGroup(groupId: string): Promise<Recipient[]> {
      return opts.groups?.[groupId] ?? []
    },
    async sendMail(): Promise<{ messageId: string }> {
      return { messageId: '<fake-kernel-mail@test>' }
    },
    async portalPublish(contentPostId, _title, _body, externalRef): Promise<{ news_posts_id: string }> {
      // Record the externalRef seen so a re-publish assertion can prove it was
      // forwarded (kernel-side idempotency anchor).
      opts.portalCalls?.push(externalRef ?? '')
      portalSeq += 1
      return { news_posts_id: externalRef ?? String(1000 + portalSeq) }
    },
  }
}

function deps(sql: Awaited<ReturnType<typeof storeFor>>, kernel: KernelClient, transport: ChannelTransport) {
  return { sql, kernel, emailTransport: transport, origin: 'https://pubchan.example' }
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
  sql = await storeFor(TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
})

afterAll(async () => {
  await _resetTenantStoreForTests()
  await dropTestDbs(admin)
  await admin.end()
})

beforeEach(async () => {
  await sql`DELETE FROM content.deliveries`
  await sql`DELETE FROM content.send_tokens`
  await sql`DELETE FROM content.unsubscribes`
  await sql`DELETE FROM content.post_recipients`
  await sql`DELETE FROM content.post_channels`
  await sql`DELETE FROM outbox`
  await sql`DELETE FROM content.publish_ops`
  await sql`DELETE FROM content.publications`
  await sql`DELETE FROM content.posts`
  await sql`DELETE FROM content.mailing_list_members`
  await sql`DELETE FROM content.mailing_lists`
})

// ── helpers ───────────────────────────────────────────────────────────────────

async function makePost(bodyHtml = '<p>Hello</p>'): Promise<string> {
  const post = await createPost(sql, {
    slug: `slug-${Math.random().toString(36).slice(2)}`,
    title: 'Test Post',
    body_html: bodyHtml,
    created_by: 'actor',
  })
  return post.id
}

async function enableChannel(postId: string, channel: 'email' | 'portal' | 'instagram'): Promise<void> {
  await sql`
    INSERT INTO content.post_channels (post_id, channel, enabled, status)
    VALUES (${postId}, ${channel}, true, 'draft')
    ON CONFLICT (post_id, channel) DO UPDATE SET enabled = true, status = 'draft'
  `
}

async function addEmailRecipients(postId: string, emails: string[]): Promise<void> {
  const list = await createMailingList(sql, 'List')
  for (const e of emails) await addListMember(sql, list.id, e, null, 'manual')
  await setPostChannelRecipients(sql, postId, 'email', [{ mailing_list_id: list.id }])
}

async function outboxRows(): Promise<
  Array<{ event_type: string; payload: Record<string, unknown>; correlation_id: string | null }>
> {
  return sql<{ event_type: string; payload: Record<string, unknown>; correlation_id: string | null }[]>`
    SELECT event_type, payload, correlation_id FROM outbox ORDER BY created_at
  `
}

// ── gating (ChannelNotPublishableError → 409) ───────────────────────────────────

describe('publishChannel — gating', () => {
  it('throws ChannelNotPublishableError when the post does not exist', async () => {
    await expect(
      publishChannel(TENANT, '00000000-0000-0000-0000-000000000000', 'email', deps(sql, makeFakeKernel(), makeFakeEmailTransport())),
    ).rejects.toBeInstanceOf(ChannelNotPublishableError)
  })

  it('throws when the channel row is missing (never opted in)', async () => {
    const postId = await makePost()
    await expect(
      publishChannel(TENANT, postId, 'email', deps(sql, makeFakeKernel(), makeFakeEmailTransport())),
    ).rejects.toThrow(/channel not found/)
  })

  it('throws when the channel is disabled', async () => {
    const postId = await makePost()
    await sql`INSERT INTO content.post_channels (post_id, channel, enabled) VALUES (${postId}, 'email', false)`
    await expect(
      publishChannel(TENANT, postId, 'email', deps(sql, makeFakeKernel(), makeFakeEmailTransport())),
    ).rejects.toThrow(/disabled/)
  })
})

// ── email channel ───────────────────────────────────────────────────────────────

describe('publishChannel — email', () => {
  it('sends to every recipient and returns sent + recipientCount, advancing channel status', async () => {
    const postId = await makePost()
    await enableChannel(postId, 'email')
    await addEmailRecipients(postId, ['alice@x.com', 'bob@x.com'])
    const transport = makeFakeEmailTransport()

    const result = await publishChannel(TENANT, postId, 'email', deps(sql, makeFakeKernel(), transport))

    expect(result).toMatchObject({ channel: 'email', status: 'sent', recipientCount: 2 })
    expect(transport.countFor('alice@x.com')).toBe(1)
    expect(transport.countFor('bob@x.com')).toBe(1)
    expect((await getChannelRow(sql, postId, 'email'))!.status).toBe('sent')

    const dels = await sql<{ status: string }[]>`SELECT status FROM content.deliveries WHERE post_id = ${postId}`
    expect(dels.every((d) => d.status === 'sent')).toBe(true)
  })

  it('a re-publish is idempotent: already-sent recipients are not re-sent, still sent', async () => {
    const postId = await makePost()
    await enableChannel(postId, 'email')
    await addEmailRecipients(postId, ['alice@x.com'])
    const transport = makeFakeEmailTransport()

    await publishChannel(TENANT, postId, 'email', deps(sql, makeFakeKernel(), transport))
    const second = await publishChannel(TENANT, postId, 'email', deps(sql, makeFakeKernel(), transport))

    expect(transport.countFor('alice@x.com')).toBe(1) // NOT re-sent
    expect(second.status).toBe('sent') // an all-already-sent re-publish is still a success
  })

  it('no recipients resolved → failed:"no recipients", channel status failed', async () => {
    const postId = await makePost()
    await enableChannel(postId, 'email')
    // no recipients set
    const result = await publishChannel(TENANT, postId, 'email', deps(sql, makeFakeKernel(), makeFakeEmailTransport()))
    expect(result).toMatchObject({ channel: 'email', status: 'failed', detail: 'no recipients' })
    expect((await getChannelRow(sql, postId, 'email'))!.status).toBe('failed')
  })

  it('SMTP unconfigured → failed:"SMTP not configured", claim RELEASED, channel status untouched', async () => {
    const postId = await makePost()
    await enableChannel(postId, 'email')
    await addEmailRecipients(postId, ['alice@x.com'])
    const transport = makeFakeEmailTransport({ mailUnconfigured: true })

    const result = await publishChannel(TENANT, postId, 'email', deps(sql, makeFakeKernel(), transport))

    expect(result).toMatchObject({ channel: 'email', status: 'failed', detail: 'SMTP not configured' })
    // The claim was released — no durable delivery row, so a later publish (once
    // SMTP is configured) sees the recipient fresh again.
    const dels = await sql<{ c: string }[]>`SELECT count(*) AS c FROM content.deliveries WHERE post_id = ${postId}`
    expect(Number(dels[0]!.c)).toBe(0)
    // Channel status NOT flipped to failed (mirrors the kernel renderer pre-check).
    expect((await getChannelRow(sql, postId, 'email'))!.status).toBe('draft')
  })

  it('SMTP removed after a prior send → failed (NOT a false "sent"), remaining recipient not dropped silently', async () => {
    // Regression for the mid-loop guard: alice was delivered on a prior pass;
    // SMTP is then removed and bob added. A re-publish must NOT report 'sent'
    // (which would silently drop bob) — it must fail so the operator re-publishes.
    const postId = await makePost()
    await enableChannel(postId, 'email')
    await addEmailRecipients(postId, ['alice@x.com', 'bob@x.com'])
    // Simulate alice already delivered on a prior pass.
    await sql`INSERT INTO content.deliveries (post_id, email, status) VALUES (${postId}, 'alice@x.com', 'sent')`

    const transport = makeFakeEmailTransport({ mailUnconfigured: true })
    const result = await publishChannel(TENANT, postId, 'email', deps(sql, makeFakeKernel(), transport))

    expect(result.status).toBe('failed')
    expect(result.detail).toBe('SMTP not configured')
    // bob's claim was released (no durable 'claimed' row), so a retry sees him fresh.
    const bob = await sql<{ status: string }[]>`SELECT status FROM content.deliveries WHERE post_id = ${postId} AND email = 'bob@x.com'`
    expect(bob).toHaveLength(0)
  })
})

// ── F1-FIX-07 H07 (K5#0): a transient per-recipient failure is retried ────────────
// 3 recipients, the send to #2 fails ONCE. The first publish must not report the
// channel 'sent' (failedCount > 0); a re-publish delivers #2 exactly once and
// never re-sends #1 or #3.

describe('publishChannel — email transient failure is retried exactly once (H07)', () => {
  function makeFailOnceTransport(failOnce: string) {
    const sent: string[] = []
    let failed = false
    let seq = 0
    return {
      sent,
      countFor: (email: string) => sent.filter((t) => t === email).length,
      async send(msg: { to?: string }): Promise<{ id: string }> {
        if (msg.to === failOnce && !failed) {
          failed = true
          throw new Error('SMTP 451 4.7.1 try again later')
        }
        sent.push(msg.to ?? '')
        seq += 1
        return { id: `<retry-${seq}@test>` }
      },
    }
  }

  it('first pass reports failed (not sent); the republish delivers #2 exactly once', async () => {
    const postId = await makePost()
    await enableChannel(postId, 'email')
    await addEmailRecipients(postId, ['one@x.com', 'two@x.com', 'three@x.com'])
    const transport = makeFailOnceTransport('two@x.com')

    const first = await publishChannel(TENANT, postId, 'email', deps(sql, makeFakeKernel(), transport))
    expect(first.status).toBe('failed')
    expect(first.recipientCount).toBe(2)
    expect(first.warnings.join(' ')).toMatch(/two@x\.com/)
    expect((await getChannelRow(sql, postId, 'email'))!.status).not.toBe('sent')
    // A partial pass invents no channel.email.sent event.
    expect(await outboxRows()).toHaveLength(0)

    const second = await publishChannel(TENANT, postId, 'email', deps(sql, makeFakeKernel(), transport))
    expect(second.status).toBe('sent')
    expect(transport.countFor('one@x.com')).toBe(1)
    expect(transport.countFor('two@x.com')).toBe(1)
    expect(transport.countFor('three@x.com')).toBe(1)
    expect((await getChannelRow(sql, postId, 'email'))!.status).toBe('sent')

    const dels = await sql<{ email: string; status: string }[]>`
      SELECT email, status FROM content.deliveries WHERE post_id = ${postId} ORDER BY email`
    expect(dels.map((d) => d.status)).toEqual(['sent', 'sent', 'sent'])
  })

  it('a third publish after success re-sends nobody', async () => {
    const postId = await makePost()
    await enableChannel(postId, 'email')
    await addEmailRecipients(postId, ['one@x.com', 'two@x.com', 'three@x.com'])
    const transport = makeFailOnceTransport('two@x.com')

    await publishChannel(TENANT, postId, 'email', deps(sql, makeFakeKernel(), transport))
    await publishChannel(TENANT, postId, 'email', deps(sql, makeFakeKernel(), transport))
    const third = await publishChannel(TENANT, postId, 'email', deps(sql, makeFakeKernel(), transport))

    expect(third.status).toBe('sent')
    expect(transport.sent).toHaveLength(3)
  })
})

// ── portal channel ────────────────────────────────────────────────────────────

describe('publishChannel — portal', () => {
  it('publishes via kernel.portalPublish, stores the linkage, returns published + externalRef', async () => {
    const postId = await makePost('<p>Portal body</p>')
    await enableChannel(postId, 'portal')
    const portalCalls: string[] = []
    const kernel = makeFakeKernel({ portalCalls })

    const result = await publishChannel(TENANT, postId, 'portal', deps(sql, kernel, makeFakeEmailTransport()))

    expect(result).toMatchObject({ channel: 'portal', status: 'published' })
    expect(result.externalRef).toBeTruthy()
    const pub = await getPublication(sql, postId, 'portal')
    expect(pub!.external_ref).toBe(result.externalRef)
    expect((await getChannelRow(sql, postId, 'portal'))!.status).toBe('published')
    // First publish forwards no externalRef.
    expect(portalCalls).toEqual([''])
  })

  it('re-publish forwards the stored external_ref and keeps ONE publication row', async () => {
    const postId = await makePost('<p>Portal body</p>')
    await enableChannel(postId, 'portal')
    const portalCalls: string[] = []
    const kernel = makeFakeKernel({ portalCalls })

    const first = await publishChannel(TENANT, postId, 'portal', deps(sql, kernel, makeFakeEmailTransport()))
    await publishChannel(TENANT, postId, 'portal', deps(sql, kernel, makeFakeEmailTransport()))

    // Second call forwarded the first external_ref as the idempotency anchor.
    expect(portalCalls[1]).toBe(first.externalRef)
    const rows = await sql<{ c: string }[]>`SELECT count(*) AS c FROM content.publications WHERE post_id = ${postId} AND channel = 'portal'`
    expect(Number(rows[0]!.c)).toBe(1)
  })
})

// ── instagram channel ─────────────────────────────────────────────────────────

describe('publishChannel — instagram', () => {
  it('enqueues a publish_op and returns scheduled', async () => {
    const postId = await makePost()
    await enableChannel(postId, 'instagram')

    const result = await publishChannel(TENANT, postId, 'instagram', deps(sql, makeFakeKernel(), makeFakeEmailTransport()))

    expect(result).toMatchObject({ channel: 'instagram', status: 'scheduled' })
    const ops = await sql<{ status: string }[]>`SELECT status FROM content.publish_ops WHERE post_id = ${postId}`
    expect(ops).toHaveLength(1)
    expect(ops[0]!.status).toBe('pending')
  })
})

// ── outbox events (co-committed per successful publish) ─────────────────────────
// Each successful per-channel publish must co-commit EXACTLY ONE outbox row whose
// payload equals what the whole-post dispatch() emits for the same transition
// (dispatch.ts: channel.email.sent {postId, recipientCount, deliveredCount},
// channel.portal.sent {postId, news_posts_id}, channel.instagram.enqueued {postId}).
// A FAILED publish invents NO event.

describe('publishChannel — outbox events', () => {
  it('email success writes exactly one channel.email.sent matching dispatch shape', async () => {
    const postId = await makePost()
    await enableChannel(postId, 'email')
    await addEmailRecipients(postId, ['alice@x.com', 'bob@x.com'])

    await publishChannel(TENANT, postId, 'email', deps(sql, makeFakeKernel(), makeFakeEmailTransport()))

    const rows = await outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event_type).toBe('channel.email.sent')
    // recipientCount = resolved audience; deliveredCount = freshly-sent this pass.
    expect(rows[0]!.payload).toEqual({ postId, recipientCount: 2, deliveredCount: 2 })
  })

  it('portal success writes exactly one channel.portal.sent with news_posts_id = externalRef', async () => {
    const postId = await makePost('<p>Portal body</p>')
    await enableChannel(postId, 'portal')

    const result = await publishChannel(TENANT, postId, 'portal', deps(sql, makeFakeKernel(), makeFakeEmailTransport()))

    const rows = await outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event_type).toBe('channel.portal.sent')
    expect(rows[0]!.payload).toEqual({ postId, news_posts_id: result.externalRef })
  })

  it('instagram success writes exactly one channel.instagram.enqueued with {postId}', async () => {
    const postId = await makePost()
    await enableChannel(postId, 'instagram')

    await publishChannel(TENANT, postId, 'instagram', deps(sql, makeFakeKernel(), makeFakeEmailTransport()))

    const rows = await outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event_type).toBe('channel.instagram.enqueued')
    expect(rows[0]!.payload).toEqual({ postId })
  })

  it('a failed email publish (no recipients) invents ZERO outbox rows', async () => {
    const postId = await makePost()
    await enableChannel(postId, 'email')
    // no recipients set → failed

    const result = await publishChannel(TENANT, postId, 'email', deps(sql, makeFakeKernel(), makeFakeEmailTransport()))

    expect(result.status).toBe('failed')
    expect(await outboxRows()).toHaveLength(0)
  })

  it('a failed email publish (SMTP unconfigured) invents ZERO outbox rows', async () => {
    const postId = await makePost()
    await enableChannel(postId, 'email')
    await addEmailRecipients(postId, ['alice@x.com'])
    const transport = makeFakeEmailTransport({ mailUnconfigured: true })

    const result = await publishChannel(TENANT, postId, 'email', deps(sql, makeFakeKernel(), transport))

    expect(result.status).toBe('failed')
    expect(await outboxRows()).toHaveLength(0)
  })
})

// ── route-path correlation fidelity (#361 review gap) ───────────────────────────
// Every outbox test above (and the scheduled-path tests in
// scheduler.integration.test.ts) calls publishChannel() WITHOUT a
// deps.correlationId, so `correlationId = deps.correlationId ?? postId`
// (publish-channel.ts) resolves via the FALLBACK and every assertion that checks
// correlation_id is checking correlation_id === postId. That is exactly what a
// BROKEN implementation would also produce if it ignored deps.correlationId
// entirely, or if the HTTP route (routes.ts, POST .../publish/:channel) stopped
// forwarding the inbound x-correlation-id header into that field — deleting
// either line would leave every other test in this file green.
//
// These tests supply a deps.correlationId that is DISTINCT from postId (the
// route path's real-world shape: the kernel's minted/forwarded id, never equal
// to the leaf's own postId) and assert the co-committed outbox row carries
// THAT value, not postId. Mirrors correlation-id.integration.test.ts's
// injectedCorrelationId proof, but at the publishChannel() (per-channel route)
// layer rather than dispatch() (whole-post route).

describe('publishChannel — route-path correlation fidelity', () => {
  it('email: co-committed outbox row carries the injected correlationId, NOT postId', async () => {
    const postId = await makePost()
    await enableChannel(postId, 'email')
    await addEmailRecipients(postId, ['alice@x.com'])
    const injectedCorrelationId = `corr-distinct-email-${Math.random().toString(36).slice(2)}`

    await publishChannel(TENANT, postId, 'email', {
      ...deps(sql, makeFakeKernel(), makeFakeEmailTransport()),
      correlationId: injectedCorrelationId,
    })

    const rows = await outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.correlation_id).toBe(injectedCorrelationId)
    expect(rows[0]!.correlation_id).not.toBe(postId)
  })

  it('portal: co-committed outbox row carries the injected correlationId, NOT postId', async () => {
    const postId = await makePost('<p>Portal body</p>')
    await enableChannel(postId, 'portal')
    const injectedCorrelationId = `corr-distinct-portal-${Math.random().toString(36).slice(2)}`

    await publishChannel(TENANT, postId, 'portal', {
      ...deps(sql, makeFakeKernel(), makeFakeEmailTransport()),
      correlationId: injectedCorrelationId,
    })

    const rows = await outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.correlation_id).toBe(injectedCorrelationId)
    expect(rows[0]!.correlation_id).not.toBe(postId)
  })

  it('instagram: co-committed outbox row carries the injected correlationId, NOT postId', async () => {
    const postId = await makePost()
    await enableChannel(postId, 'instagram')
    const injectedCorrelationId = `corr-distinct-instagram-${Math.random().toString(36).slice(2)}`

    await publishChannel(TENANT, postId, 'instagram', {
      ...deps(sql, makeFakeKernel(), makeFakeEmailTransport()),
      correlationId: injectedCorrelationId,
    })

    const rows = await outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.correlation_id).toBe(injectedCorrelationId)
    expect(rows[0]!.correlation_id).not.toBe(postId)
  })

  it('omitting deps.correlationId falls back to postId (the scheduled-path shape this guard is distinguished from)', async () => {
    const postId = await makePost()
    await enableChannel(postId, 'email')
    await addEmailRecipients(postId, ['alice@x.com'])

    await publishChannel(TENANT, postId, 'email', deps(sql, makeFakeKernel(), makeFakeEmailTransport()))

    const rows = await outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.correlation_id).toBe(postId)
  })
})
