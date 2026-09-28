/**
 * Integration tests for the dispatch engine (Task 18 — three-channel publish pipeline).
 *
 * Mirrors services/newsletter/test/dispatch.integration.test.ts, adapted for
 * the content leaf's three-channel Map (email, portal, instagram) instead of
 * the single MailTransport.
 *
 * Tests:
 *  - Email channel: per-recipient claim gate, unsubscribe filter, dedup
 *  - Portal channel: single kernel.portalPublish per post, idempotency via stub
 *  - Instagram channel: enqueues a publish_op (self-contained outbox)
 *  - claimPostForPublish makes a second dispatch a no-op (DoD-c proof)
 *  - Each finished channel co-commits status + outbox events in the same tx
 *
 * THE DoD-c PROOF lives here: 'duplicate dispatch sends one email per recipient'.
 *
 * Fail-closed guard mirrors store.integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { storeFor, _resetTenantStoreForTests, type TenantRef } from '../src/tenant-store.ts'
import {
  createPost,
  setPostChannelRecipients,
  createMailingList,
  addListMember,
  addUnsubscribe,
  getPost,
  getPublication,
  getPublishOp,
} from '../src/store/index.ts'
import { dispatch, type ChannelTransport } from '../src/dispatch.ts'
import type { KernelClient, Recipient } from '../src/kernel-client.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

// ── fail-closed guard ─────────────────────────────────────────────────────────
const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'content_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

const DISPATCH_TENANT: TenantRef = {
  id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  slug: 'disptest',
}
const ACTOR = 'dispatch-actor'

// ── fakes ───────────────────────────────────────────────────────────────────

/** Fake email transport that records every sendMail call. */
function makeFakeEmailTransport(opts: { failFor?: Set<string> } = {}): ChannelTransport & {
  sent: Array<{ to: string; subject: string; html: string }>
  countFor(email: string): number
} {
  const sent: Array<{ to: string; subject: string; html: string }> = []
  let seq = 0
  return {
    sent,
    countFor(email: string): number {
      return sent.filter((m) => m.to === email).length
    },
    async send(msg: { to: string; subject: string; html: string }): Promise<{ id: string }> {
      if (opts.failFor?.has(msg.to)) {
        throw new Error(`fake SMTP failure for ${msg.to}`)
      }
      sent.push({ to: msg.to, subject: msg.subject, html: msg.html })
      seq += 1
      return { id: `<fake-${seq}@test>` }
    },
  }
}

/**
 * Fake kernel client. resolveGroup resolves to a map.
 * portalPublish returns a fake news_posts_id.
 */
function makeFakeKernel(opts: {
  groups?: Record<string, Recipient[]>
  portalPublishResult?: { news_posts_id: string }
  portalPublishThrows?: boolean
} = {}): KernelClient {
  let portalSeq = 0
  return {
    async resolveGroup(groupId: string): Promise<Recipient[]> {
      return opts.groups?.[groupId] ?? []
    },
    async sendMail(): Promise<{ messageId: string }> {
      return { messageId: '<fake-kernel-mail@test>' }
    },
    async portalPublish(): Promise<{ news_posts_id: string }> {
      if (opts.portalPublishThrows) throw new Error('fake portal publish failure')
      portalSeq += 1
      return opts.portalPublishResult ?? { news_posts_id: String(1000 + portalSeq) }
    },
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
  sql = await storeFor(DISPATCH_TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
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
  await sql`DELETE FROM outbox`
  await sql`DELETE FROM content.publish_ops`
  await sql`DELETE FROM content.publications`
  await sql`DELETE FROM content.posts`
  await sql`DELETE FROM content.mailing_list_members`
  await sql`DELETE FROM content.mailing_lists`
})

// ── helpers ───────────────────────────────────────────────────────────────────

async function makePostWithEmailList(
  emails: string[],
): Promise<{ postId: string; listId: string }> {
  const post = await createPost(sql, {
    slug: `slug-${Math.random().toString(36).slice(2)}`,
    title: 'Test Post',
    body_html: '<h2>Intro</h2><p>Hello World</p>',
    created_by: ACTOR,
  })
  const list = await createMailingList(sql, 'Test List')
  for (const e of emails) await addListMember(sql, list.id, e, null, 'manual')
  await setPostChannelRecipients(sql, post.id, 'email', [{ mailing_list_id: list.id }])
  return { postId: post.id, listId: list.id }
}

async function outboxRows(): Promise<
  Array<{ event_type: string; payload: Record<string, unknown>; correlation_id: string | null }>
> {
  return sql<{ event_type: string; payload: Record<string, unknown>; correlation_id: string | null }[]>`
    SELECT event_type, payload, correlation_id FROM outbox ORDER BY created_at
  `
}

// ── email channel: happy path ─────────────────────────────────────────────────
describe('dispatch email — happy path', () => {
  it('sends to every recipient, writes deliveries+tokens+status sent + outbox events', async () => {
    const { postId } = await makePostWithEmailList(['alice@x.com', 'bob@x.com'])
    const emailTransport = makeFakeEmailTransport()

    await dispatch(DISPATCH_TENANT, postId, ACTOR, {
      sql,
      kernel: makeFakeKernel(),
      channels: new Map([['email', emailTransport]]),
      origin: 'https://disptest.example',
    })

    expect(emailTransport.sent).toHaveLength(2)
    expect(emailTransport.countFor('alice@x.com')).toBe(1)
    expect(emailTransport.countFor('bob@x.com')).toBe(1)

    const post = await getPost(sql, postId)
    expect(post!.status).toBe('sent')
    expect(post!.sent_at).not.toBeNull()

    // deliveries: both 'sent'
    const dels = await sql<{ email: string; status: string }[]>`
      SELECT email, status FROM content.deliveries WHERE post_id = ${postId} ORDER BY email`
    expect(dels.map((d) => d.status)).toEqual(['sent', 'sent'])

    // tokens minted for each
    const toks = await sql<{ c: string }[]>`
      SELECT count(*) AS c FROM content.send_tokens WHERE post_id = ${postId}`
    expect(Number(toks[0]!.c)).toBe(2)

    // outbox rows: publish.succeeded + channel.email.sent
    const rows = await outboxRows()
    const eventTypes = rows.map((r) => r.event_type).sort()
    expect(eventTypes).toContain('publish.succeeded')
    expect(eventTypes).toContain('channel.email.sent')
  })

  it('injects the unsubscribe footer with a per-recipient token into the sent html', async () => {
    const { postId } = await makePostWithEmailList(['alice@x.com'])
    const emailTransport = makeFakeEmailTransport()
    await dispatch(DISPATCH_TENANT, postId, ACTOR, {
      sql,
      kernel: makeFakeKernel(),
      channels: new Map([['email', emailTransport]]),
      origin: 'https://disptest.example',
    })
    expect(emailTransport.sent[0]!.html).toContain('unsubscribe?token=')
    expect(emailTransport.sent[0]!.html).toContain('https://disptest.example')
  })
})

// ── email channel: recipient assembly ────────────────────────────────────────
describe('dispatch email — recipient assembly', () => {
  it('dedupes across lists+groups and filters unsubscribed', async () => {
    const post = await createPost(sql, {
      slug: `slug-${Math.random().toString(36).slice(2)}`,
      title: 'NL', body_html: '<p>Body</p>', created_by: ACTOR,
    })
    const list = await createMailingList(sql, 'L')
    await addListMember(sql, list.id, 'Alice@X.com', 'Alice', 'manual')
    await addListMember(sql, list.id, 'dup@x.com', null, 'manual')
    await addUnsubscribe(sql, 'gone@x.com')
    await setPostChannelRecipients(sql, post.id, 'email', [
      { mailing_list_id: list.id },
      { keycloak_group_id: 'grp-1' },
    ])

    const emailTransport = makeFakeEmailTransport()
    const kernel = makeFakeKernel({
      groups: {
        'grp-1': [
          { email: 'DUP@x.com', name: 'Dup2' },   // duplicate
          { email: 'gone@x.com', name: 'Gone' },   // unsubscribed
          { email: 'carol@x.com', name: 'Carol' }, // new
        ],
      },
    })

    await dispatch(DISPATCH_TENANT, post.id, ACTOR, {
      sql, kernel, channels: new Map([['email', emailTransport]]),
      origin: 'https://o',
    })

    const tos = emailTransport.sent.map((m) => m.to).sort()
    expect(tos).toEqual(['alice@x.com', 'carol@x.com', 'dup@x.com'])
  })
})

// ── email channel: per-recipient failure ────────────────────────────────────
describe('dispatch email — per-recipient SMTP failure', () => {
  it('sends good ones, marks failed status, claims bad one (bounded at-least-once)', async () => {
    const { postId } = await makePostWithEmailList(['ok@x.com', 'bad@x.com'])
    const emailTransport = makeFakeEmailTransport({ failFor: new Set(['bad@x.com']) })

    await expect(
      dispatch(DISPATCH_TENANT, postId, ACTOR, {
        sql, kernel: makeFakeKernel(),
        channels: new Map([['email', emailTransport]]),
        origin: 'https://o',
      }),
    ).rejects.toThrow()

    expect(emailTransport.countFor('ok@x.com')).toBe(1)
    expect(emailTransport.countFor('bad@x.com')).toBe(0)

    const dels = await sql<{ email: string; status: string }[]>`
      SELECT email, status FROM content.deliveries WHERE post_id = ${postId} ORDER BY email`
    expect(dels.find((d) => d.email === 'ok@x.com')!.status).toBe('sent')
    expect(dels.find((d) => d.email === 'bad@x.com')!.status).toBe('claimed')

    const post = await getPost(sql, postId)
    expect(post!.status).toBe('failed')

    const rows = await outboxRows()
    expect(rows.map((r) => r.event_type)).toContain('publish.failed')
  })
})

// ── portal channel: single-call publish ────────────────────────────────────
describe('dispatch portal — happy path', () => {
  it('calls portalPublish once and stores the returned id in publications', async () => {
    const post = await createPost(sql, {
      slug: `slug-${Math.random().toString(36).slice(2)}`,
      title: 'Portal Post', body_html: '<p>Portal body</p>', created_by: ACTOR,
    })

    const kernel = makeFakeKernel({ portalPublishResult: { news_posts_id: '42' } })
    let portalCalls = 0
    const wrappedKernel: KernelClient = {
      ...kernel,
      async portalPublish(...args) {
        portalCalls++
        return kernel.portalPublish(...args)
      },
    }

    await dispatch(DISPATCH_TENANT, post.id, ACTOR, {
      sql,
      kernel: wrappedKernel,
      channels: new Map([['portal', { send: async () => ({ id: '' }) }]]),
      origin: 'https://disptest.example',
    })

    expect(portalCalls).toBe(1)

    const pub = await getPublication(sql, post.id, 'portal')
    expect(pub).not.toBeNull()
    expect(pub!.external_ref).toBe('42')

    const rows = await outboxRows()
    const eventTypes = rows.map((r) => r.event_type)
    expect(eventTypes).toContain('channel.portal.sent')
    expect(eventTypes).toContain('publish.succeeded')
  })

  it('a second dispatch is a no-op (claimPostForPublish gate)', async () => {
    const post = await createPost(sql, {
      slug: `slug-${Math.random().toString(36).slice(2)}`,
      title: 'Idempotent', body_html: '<p>Body</p>', created_by: ACTOR,
    })

    const kernel = makeFakeKernel()
    let portalCalls = 0
    const wrappedKernel: KernelClient = {
      ...kernel,
      async portalPublish(...args) {
        portalCalls++
        return kernel.portalPublish(...args)
      },
    }

    const run = () =>
      dispatch(DISPATCH_TENANT, post.id, ACTOR, {
        sql,
        kernel: wrappedKernel,
        channels: new Map([['portal', { send: async () => ({ id: '' }) }]]),
        origin: 'https://disptest.example',
      }).catch(() => {})

    await run()
    await run()

    // Only ONE portalPublish despite two dispatch calls.
    expect(portalCalls).toBe(1)
  })
})

// ── instagram channel: enqueue publish_op ────────────────────────────────────
describe('dispatch instagram — enqueue publish_op', () => {
  it('creates a publish_op row and emits channel.instagram.enqueued outbox event', async () => {
    const post = await createPost(sql, {
      slug: `slug-${Math.random().toString(36).slice(2)}`,
      title: 'IG Post', body_html: '<p>IG body</p>', created_by: ACTOR,
    })

    await dispatch(DISPATCH_TENANT, post.id, ACTOR, {
      sql,
      kernel: makeFakeKernel(),
      channels: new Map([['instagram', { send: async () => ({ id: '' }) }]]),
      origin: 'https://disptest.example',
    })

    // A publish_op row should be created for this post.
    const opRows = await sql<{ post_id: string; status: string }[]>`
      SELECT post_id, status FROM content.publish_ops WHERE post_id = ${post.id}`
    expect(opRows).toHaveLength(1)
    expect(opRows[0]!.status).toBe('pending')

    const rows = await outboxRows()
    const eventTypes = rows.map((r) => r.event_type)
    expect(eventTypes).toContain('channel.instagram.enqueued')
    expect(eventTypes).toContain('publish.succeeded')
  })
})

// ── three-channel combined dispatch ──────────────────────────────────────────
describe('dispatch — three-channel combined', () => {
  it('runs email + portal + instagram in a single dispatch', async () => {
    const post = await createPost(sql, {
      slug: `slug-${Math.random().toString(36).slice(2)}`,
      title: 'Multi Channel', body_html: '<h2>Section</h2><p>Body</p>', created_by: ACTOR,
    })
    const list = await createMailingList(sql, 'Multi List')
    await addListMember(sql, list.id, 'alice@mc.com', null, 'manual')
    await setPostChannelRecipients(sql, post.id, 'email', [{ mailing_list_id: list.id }])

    const emailTransport = makeFakeEmailTransport()

    await dispatch(DISPATCH_TENANT, post.id, ACTOR, {
      sql,
      kernel: makeFakeKernel(),
      channels: new Map<'email' | 'portal' | 'instagram', ChannelTransport>([
        ['email', emailTransport],
        ['portal', { send: async () => ({ id: '' }) }],
        ['instagram', { send: async () => ({ id: '' }) }],
      ]),
      origin: 'https://disptest.example',
    })

    // Email sent
    expect(emailTransport.countFor('alice@mc.com')).toBe(1)

    // Portal publication exists
    const pub = await getPublication(sql, post.id, 'portal')
    expect(pub).not.toBeNull()

    // Instagram publish_op exists
    const opRows = await sql<{ post_id: string }[]>`
      SELECT post_id FROM content.publish_ops WHERE post_id = ${post.id}`
    expect(opRows).toHaveLength(1)

    // All channel events in outbox
    const rows = await outboxRows()
    const eventTypes = rows.map((r) => r.event_type).sort()
    expect(eventTypes).toContain('channel.email.sent')
    expect(eventTypes).toContain('channel.portal.sent')
    expect(eventTypes).toContain('channel.instagram.enqueued')
    expect(eventTypes).toContain('publish.succeeded')
  })
})

// ── DoD-c PROOF: duplicate dispatch sends one email per recipient ─────────────
describe('DoD-c — duplicate-send prevention', () => {
  it('concurrent and sequential re-dispatches send exactly one message per recipient', async () => {
    const recipients = ['alice@x.com', 'bob@x.com', 'carol@x.com']
    const { postId } = await makePostWithEmailList(recipients)

    const emailTransport = makeFakeEmailTransport()
    const run = () =>
      dispatch(DISPATCH_TENANT, postId, ACTOR, {
        sql,
        kernel: makeFakeKernel(),
        channels: new Map([['email', emailTransport]]),
        origin: 'https://o',
      }).catch(() => {})

    // CONCURRENT: two dispatches at once.
    await Promise.all([run(), run()])
    // SEQUENTIAL: a third after completion.
    await run()

    for (const r of recipients) {
      expect(emailTransport.countFor(r)).toBe(1)
    }
    expect(emailTransport.sent).toHaveLength(recipients.length)
  })
})
