/**
 * Integration tests for services/content/src/store/*.ts
 *
 * Mirrors services/newsletter/test/store.integration.test.ts, extended with
 * content-specific tables: post_channels, publications, publish_ops, media.
 *
 * Must-cover contracts:
 *   - claimPostForPublish is ATOMIC under 2 concurrent claims (exactly one wins)
 *   - claimRecipient: fresh / in-flight / already-sent / stale-takeover
 *   - addUnsubscribeByToken: expired / invalid / valid
 *   - markFailed records error_message
 *   - countPostRecipients via mailing lists
 *   - publish_ops drain (backoff, give-up)
 *   - per-tenant isolation
 *
 * Fail-closed guard: refuses to run unless host is localhost/127.0.0.1
 * and all test DBs use the content_test_ prefix.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { storeFor, _resetTenantStoreForTests, type TenantRef } from '../src/tenant-store.ts'
import {
  // lists
  createMailingList,
  listMailingLists,
  deleteMailingList,
  addListMember,
  listMembers,
  removeListMember,
  // posts
  createPost,
  listPosts,
  getPost,
  updatePost,
  claimPostForPublish,
  resetStuckPublishing,
  countPostRecipients,
  // post-channels
  setPostChannelRecipients,
  getPostChannelRecipients,
  // media
  createMedia,
  getMedia,
  listMediaByPost,
  // deliveries
  claimRecipient,
  markSent,
  markFailed,
  // tokens
  addUnsubscribe,
  isUnsubscribed,
  addSendToken,
  purgeSendTokensOlderThan90Days,
  // publications
  createPublication,
  getPublication,
  listPublications,
  // publish-ops
  createPublishOp,
  getPublishOp,
  updatePublishOp,
  drainPublishOps,
  // audit
  recordContentAudit,
} from '../src/store/index.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

// ── fail-closed guard (mirrors #249 / assert-safe-test-db-url pattern) ────────
const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'content_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

// ── test tenant ───────────────────────────────────────────────────────────────
const STORE_TENANT: TenantRef = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  slug: 'storetest',
}

// ── helpers ───────────────────────────────────────────────────────────────────
let admin: ReturnType<typeof postgres>
let sql: Awaited<ReturnType<typeof storeFor>>

async function dropTestDbs(pgSql: ReturnType<typeof postgres>): Promise<void> {
  const rows = await pgSql<{ datname: string }[]>`
    SELECT datname FROM pg_database
    WHERE datname LIKE 'content_test_%'
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
  sql = await storeFor(STORE_TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
})

afterAll(async () => {
  await _resetTenantStoreForTests()
  await dropTestDbs(admin)
  await admin.end()
})

// Clear all content.* tables before each test for hermeticity (FK-safe order).
beforeEach(async () => {
  await sql`DELETE FROM content.content_audit`
  await sql`DELETE FROM content.publications`
  await sql`DELETE FROM content.publish_ops`
  await sql`DELETE FROM content.deliveries`
  await sql`DELETE FROM content.send_tokens`
  await sql`DELETE FROM content.unsubscribes`
  await sql`DELETE FROM content.post_recipients`
  await sql`DELETE FROM content.post_channels`
  await sql`DELETE FROM content.post_media`
  await sql`DELETE FROM content.posts`
  await sql`DELETE FROM content.mailing_list_members`
  await sql`DELETE FROM content.mailing_lists`
  await sql`DELETE FROM event_consumption`
  await sql`DELETE FROM outbox`
})

// ── helper: create a post ─────────────────────────────────────────────────────
async function mkPost(overrides?: { title?: string; body_html?: string }) {
  return createPost(sql, {
    slug: `slug-${Math.random().toString(36).slice(2)}`,
    title: overrides?.title ?? 'Test Post',
    body_html: overrides?.body_html ?? '<p>Hello</p>',
    created_by: 'user-uuid',
  })
}

// ── mailing lists ─────────────────────────────────────────────────────────────
describe('mailing lists', () => {
  it('creates and lists a mailing list', async () => {
    const list = await createMailingList(sql, 'AStA Verteiler')
    expect(list.id).toBeTypeOf('string') // UUID
    expect(list.name).toBe('AStA Verteiler')
    const all = await listMailingLists(sql)
    expect(all).toHaveLength(1)
  })

  it('deletes a mailing list and cascades members', async () => {
    const list = await createMailingList(sql, 'Test')
    await addListMember(sql, list.id, 'a@b.de', null, 'manual')
    await deleteMailingList(sql, list.id)
    expect(await listMailingLists(sql)).toHaveLength(0)
    expect(await listMembers(sql, list.id)).toHaveLength(0)
  })
})

// ── members ───────────────────────────────────────────────────────────────────
describe('members', () => {
  it('adds and lists members', async () => {
    const list = await createMailingList(sql, 'Test')
    await addListMember(sql, list.id, 'a@b.de', 'Anna', 'csv')
    const members = await listMembers(sql, list.id)
    expect(members).toHaveLength(1)
    expect(members[0]!.email).toBe('a@b.de')
    expect(members[0]!.source).toBe('csv')
  })

  it('ignores duplicate emails within same list', async () => {
    const list = await createMailingList(sql, 'Test')
    await addListMember(sql, list.id, 'a@b.de', null, 'csv')
    await addListMember(sql, list.id, 'a@b.de', null, 'manual') // duplicate — ignored
    expect(await listMembers(sql, list.id)).toHaveLength(1)
  })

  it('removes a member', async () => {
    const list = await createMailingList(sql, 'Test')
    await addListMember(sql, list.id, 'a@b.de', null, 'manual')
    const members = await listMembers(sql, list.id)
    await removeListMember(sql, members[0]!.id)
    expect(await listMembers(sql, list.id)).toHaveLength(0)
  })
})

// ── posts ─────────────────────────────────────────────────────────────────────
describe('posts', () => {
  it('creates and retrieves a post', async () => {
    const p = await mkPost({ title: 'Hello World' })
    expect(p.id).toBeTypeOf('string') // UUID
    expect(p.status).toBe('draft')
    const got = await getPost(sql, p.id)
    expect(got).toMatchObject({ title: 'Hello World' })
  })

  it('listPosts returns all posts', async () => {
    await mkPost({ title: 'A' })
    await mkPost({ title: 'B' })
    const all = await listPosts(sql)
    expect(all).toHaveLength(2)
  })

  it('getPost returns null for missing id', async () => {
    const got = await getPost(sql, '00000000-0000-0000-0000-000000000000')
    expect(got).toBeNull()
  })

  it('updatePost partial-sets fields', async () => {
    const p = await mkPost()
    await updatePost(sql, p.id, { status: 'scheduled', scheduled_at: '2026-05-01T10:00:00Z' })
    const got = await getPost(sql, p.id)
    expect(got!.status).toBe('scheduled')
    expect(got!.scheduled_at).toBeTruthy()
  })

  it('countPostRecipients counts distinct member emails via mailing lists', async () => {
    const p = await mkPost()
    const l1 = await createMailingList(sql, 'L1')
    const l2 = await createMailingList(sql, 'L2')
    await addListMember(sql, l1.id, 'a@b.de', null, 'csv')
    await addListMember(sql, l1.id, 'b@b.de', null, 'csv')
    await addListMember(sql, l2.id, 'a@b.de', null, 'csv') // same email on l2
    await setPostChannelRecipients(sql, p.id, 'email', [
      { mailing_list_id: l1.id },
      { mailing_list_id: l2.id },
    ])
    const count = await countPostRecipients(sql, p.id)
    expect(count).toBe(2) // a@b.de counted once, b@b.de once
  })
})

// ── claimPostForPublish ───────────────────────────────────────────────────────
describe('claimPostForPublish', () => {
  it('transitions draft→sending and returns true', async () => {
    const p = await mkPost()
    const claimed = await claimPostForPublish(sql, p.id)
    expect(claimed).toBe(true)
    const got = await getPost(sql, p.id)
    expect(got!.status).toBe('sending')
  })

  it('returns false when already sending', async () => {
    const p = await mkPost()
    await claimPostForPublish(sql, p.id)
    const second = await claimPostForPublish(sql, p.id)
    expect(second).toBe(false)
  })

  it('returns false when already sent', async () => {
    const p = await mkPost()
    await updatePost(sql, p.id, { status: 'sent' })
    const claimed = await claimPostForPublish(sql, p.id)
    expect(claimed).toBe(false)
  })

  it('returns false for a non-existent id', async () => {
    const claimed = await claimPostForPublish(sql, '00000000-0000-0000-0000-000000000000')
    expect(claimed).toBe(false)
  })

  it('ATOMIC: under 2 concurrent claims exactly one wins', async () => {
    const p = await mkPost()
    const [r1, r2] = await Promise.all([
      claimPostForPublish(sql, p.id),
      claimPostForPublish(sql, p.id),
    ])
    const wins = [r1, r2].filter(Boolean)
    expect(wins).toHaveLength(1)
    const got = await getPost(sql, p.id)
    expect(got!.status).toBe('sending')
  })
})

// ── resetStuckPublishing ──────────────────────────────────────────────────────
describe('resetStuckPublishing', () => {
  it('resets posts stuck in sending longer than the cutoff', async () => {
    const p = await mkPost()
    await claimPostForPublish(sql, p.id)
    await sql`UPDATE content.posts SET updated_at = now() - interval '2 hours' WHERE id = ${p.id}`
    const count = await resetStuckPublishing(sql, 60)
    expect(count).toBeGreaterThanOrEqual(1)
    const got = await getPost(sql, p.id)
    expect(got!.status).toBe('failed')
  })

  it('does NOT reset posts stuck for less than the cutoff', async () => {
    const p = await mkPost()
    await claimPostForPublish(sql, p.id)
    const count = await resetStuckPublishing(sql, 60)
    expect(count).toBe(0)
    const got = await getPost(sql, p.id)
    expect(got!.status).toBe('sending')
  })
})

// ── post-channels ─────────────────────────────────────────────────────────────
describe('post-channels', () => {
  it('setPostChannelRecipients sets and replaces recipients for a channel', async () => {
    const p = await mkPost()
    const l1 = await createMailingList(sql, 'L1')
    const l2 = await createMailingList(sql, 'L2')

    await setPostChannelRecipients(sql, p.id, 'email', [{ mailing_list_id: l1.id }])
    let recips = await getPostChannelRecipients(sql, p.id, 'email')
    expect(recips).toHaveLength(1)

    // Replace
    await setPostChannelRecipients(sql, p.id, 'email', [
      { mailing_list_id: l2.id },
      { keycloak_group_id: 'group-uuid' },
    ])
    recips = await getPostChannelRecipients(sql, p.id, 'email')
    expect(recips).toHaveLength(2)
    const listIds = recips.map((r) => r.mailing_list_id)
    expect(listIds).toContain(l2.id)
  })

  it('getPostChannelRecipients returns empty array for post with no recipients', async () => {
    const p = await mkPost()
    const recips = await getPostChannelRecipients(sql, p.id, 'email')
    expect(recips).toHaveLength(0)
  })
})

// ── media ─────────────────────────────────────────────────────────────────────
describe('media', () => {
  it('creates and retrieves a media item', async () => {
    const p = await mkPost()
    const m = await createMedia(sql, { post_id: p.id, url: 'https://cdn/img.jpg', role: 'hero', position: 0, alt: 'hero image' })
    expect(m.id).toBeTypeOf('string')
    expect(m.role).toBe('hero')
    const got = await getMedia(sql, m.id)
    expect(got).toMatchObject({ url: 'https://cdn/img.jpg' })
  })

  it('listMediaByPost returns all media for a post in position order', async () => {
    const p = await mkPost()
    await createMedia(sql, { post_id: p.id, url: 'https://cdn/slide1.jpg', role: 'slide', position: 1 })
    await createMedia(sql, { post_id: p.id, url: 'https://cdn/slide0.jpg', role: 'slide', position: 0 })
    const items = await listMediaByPost(sql, p.id)
    expect(items).toHaveLength(2)
    expect(items[0]!.position).toBe(0)
    expect(items[1]!.position).toBe(1)
  })

  it('getMedia returns null for missing id', async () => {
    const got = await getMedia(sql, '00000000-0000-0000-0000-000000000000')
    expect(got).toBeNull()
  })

  it('cascades delete when post is deleted', async () => {
    const p = await mkPost()
    await createMedia(sql, { post_id: p.id, url: 'https://cdn/img.jpg', role: 'inline', position: 0 })
    await sql`DELETE FROM content.posts WHERE id = ${p.id}`
    const items = await listMediaByPost(sql, p.id)
    expect(items).toHaveLength(0)
  })
})

// ── deliveries ────────────────────────────────────────────────────────────────
describe('deliveries', () => {
  it('claimRecipient returns fresh for a new (post, email)', async () => {
    const p = await mkPost()
    const result = await claimRecipient(sql, p.id, 'a@b.de')
    expect(result).toBe('fresh')
  })

  it('claimRecipient returns in-flight for an existing non-stale claimed row', async () => {
    const p = await mkPost()
    await claimRecipient(sql, p.id, 'a@b.de')
    const result = await claimRecipient(sql, p.id, 'a@b.de')
    expect(result).toBe('in-flight')
  })

  it('markSent + claimRecipient returns already-sent', async () => {
    const p = await mkPost()
    await claimRecipient(sql, p.id, 'a@b.de')
    await markSent(sql, p.id, 'a@b.de', 'msg-id-123')
    const result = await claimRecipient(sql, p.id, 'a@b.de')
    expect(result).toBe('already-sent')
  })

  it('markFailed records error_message', async () => {
    const p = await mkPost()
    await claimRecipient(sql, p.id, 'a@b.de')
    await markFailed(sql, p.id, 'a@b.de', 'SMTP connection refused')
    const rows = await sql<{ status: string; error_message: string }[]>`
      SELECT status, error_message FROM content.deliveries
      WHERE post_id = ${p.id} AND email = ${'a@b.de'}
    `
    expect(rows[0]!.status).toBe('failed')
    expect(rows[0]!.error_message).toBe('SMTP connection refused')
  })

  it('stale-claim takeover: a stale claimed row is re-claimed as fresh', async () => {
    const p = await mkPost()
    await claimRecipient(sql, p.id, 'stale@b.de')
    // Age the claimed_at to beyond the stale window (15 min).
    await sql`
      UPDATE content.deliveries
      SET claimed_at = now() - interval '20 minutes'
      WHERE post_id = ${p.id} AND email = ${'stale@b.de'}
    `
    const result = await claimRecipient(sql, p.id, 'stale@b.de')
    expect(result).toBe('fresh')
  })
})

// ── unsubscribes ──────────────────────────────────────────────────────────────
describe('unsubscribes', () => {
  it('addUnsubscribe records unsubscribe and isUnsubscribed detects it', async () => {
    await addUnsubscribe(sql, 'a@b.de')
    expect(await isUnsubscribed(sql, 'a@b.de')).toBe(true)
    expect(await isUnsubscribed(sql, 'other@b.de')).toBe(false)
  })

  it('addUnsubscribe is idempotent (duplicate ignored)', async () => {
    await addUnsubscribe(sql, 'a@b.de')
    await expect(addUnsubscribe(sql, 'a@b.de')).resolves.not.toThrow()
    expect(await isUnsubscribed(sql, 'a@b.de')).toBe(true)
  })
})

// ── send tokens ───────────────────────────────────────────────────────────────
describe('send_tokens', () => {
  it('addSendToken default expires_at ≈ now()+7d', async () => {
    const p = await mkPost()
    const before = Date.now()
    await addSendToken(sql, 'tok-fresh', p.id, 'a@b.de')
    const rows = await sql<{ expires_at: Date }[]>`SELECT expires_at FROM content.send_tokens WHERE token = 'tok-fresh'`
    expect(rows).toHaveLength(1)
    const expiresAt = rows[0]!.expires_at
    const expected7d = before + 7 * 24 * 60 * 60 * 1000
    expect(Math.abs(expiresAt.getTime() - expected7d)).toBeLessThan(60_000)
  })

  it('addSendToken returns the persisted token (reuse on conflict)', async () => {
    const p = await mkPost()
    const first = await addSendToken(sql, 'tok-orig', p.id, 'a@b.de')
    const second = await addSendToken(sql, 'tok-new', p.id, 'a@b.de')
    expect(first).toBe('tok-orig')
    expect(second).toBe('tok-orig')
  })

  it('purgeSendTokensOlderThan90Days removes tokens for posts sent >90d ago', async () => {
    const p = await mkPost()
    await updatePost(sql, p.id, { status: 'sent', sent_at: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString() })
    await addSendToken(sql, 'tok-old', p.id, 'a@b.de')
    await purgeSendTokensOlderThan90Days(sql)
    const rows = await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM content.send_tokens`
    expect(Number(rows[0]!.c)).toBe(0)
  })

  it('purgeSendTokensOlderThan90Days keeps tokens for recently sent posts', async () => {
    const p = await mkPost()
    await updatePost(sql, p.id, { status: 'sent', sent_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() })
    await addSendToken(sql, 'tok-recent', p.id, 'a@b.de')
    await purgeSendTokensOlderThan90Days(sql)
    const rows = await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM content.send_tokens`
    expect(Number(rows[0]!.c)).toBe(1)
  })
})

// ── publications ──────────────────────────────────────────────────────────────
describe('publications', () => {
  it('createPublication and getPublication roundtrip', async () => {
    const p = await mkPost()
    await createPublication(sql, { post_id: p.id, channel: 'portal', external_ref: '42' })
    const pub = await getPublication(sql, p.id, 'portal')
    expect(pub).not.toBeNull()
    expect(pub!.external_ref).toBe('42')
    expect(pub!.published_at).toBeTruthy()
  })

  it('createPublication is idempotent via ON CONFLICT DO UPDATE', async () => {
    const p = await mkPost()
    await createPublication(sql, { post_id: p.id, channel: 'portal', external_ref: 'ref-1' })
    await createPublication(sql, { post_id: p.id, channel: 'portal', external_ref: 'ref-2' })
    const pub = await getPublication(sql, p.id, 'portal')
    expect(pub!.external_ref).toBe('ref-2')
  })

  it('listPublications returns all channels for a post', async () => {
    const p = await mkPost()
    await createPublication(sql, { post_id: p.id, channel: 'portal', external_ref: '1' })
    await createPublication(sql, { post_id: p.id, channel: 'email' })
    const pubs = await listPublications(sql, p.id)
    expect(pubs).toHaveLength(2)
  })

  it('getPublication returns null when not found', async () => {
    const p = await mkPost()
    const pub = await getPublication(sql, p.id, 'instagram')
    expect(pub).toBeNull()
  })
})

// ── publish_ops ───────────────────────────────────────────────────────────────
describe('publish_ops', () => {
  it('createPublishOp and getPublishOp roundtrip', async () => {
    const p = await mkPost()
    const op = await createPublishOp(sql, { post_id: p.id })
    expect(op.id).toBeTypeOf('string')
    expect(op.status).toBe('pending')
    const got = await getPublishOp(sql, op.id)
    expect(got).not.toBeNull()
    expect(got!.post_id).toBe(p.id)
  })

  it('createPublishOp is idempotent (UNIQUE post_id, op)', async () => {
    const p = await mkPost()
    const op1 = await createPublishOp(sql, { post_id: p.id })
    const op2 = await createPublishOp(sql, { post_id: p.id })
    expect(op1.id).toBe(op2.id)
  })

  it('updatePublishOp updates status and fields', async () => {
    const p = await mkPost()
    const op = await createPublishOp(sql, { post_id: p.id })
    await updatePublishOp(sql, op.id, { status: 'ok', external_ref: 'meta-123' })
    const got = await getPublishOp(sql, op.id)
    expect(got!.status).toBe('ok')
    expect(got!.external_ref).toBe('meta-123')
  })

  it('drainPublishOps returns only due pending ops', async () => {
    const p1 = await mkPost({ title: 'P1' })
    const p2 = await mkPost({ title: 'P2' })
    await createPublishOp(sql, { post_id: p1.id })
    await createPublishOp(sql, { post_id: p2.id })
    // Set p2 op to due in the future
    await sql`UPDATE content.publish_ops SET next_attempt_at = now() + interval '1 hour' WHERE post_id = ${p2.id}`
    const ops = await drainPublishOps(sql)
    const postIds = ops.map((o) => o.post_id)
    expect(postIds).toContain(p1.id)
    expect(postIds).not.toContain(p2.id)
  })

  it('drainPublishOps excludes ok ops', async () => {
    const p = await mkPost()
    const op = await createPublishOp(sql, { post_id: p.id })
    await updatePublishOp(sql, op.id, { status: 'ok' })
    const ops = await drainPublishOps(sql)
    expect(ops.map((o) => o.id)).not.toContain(op.id)
  })

  it('drainPublishOps excludes ops past the 24 h give-up window', async () => {
    const p = await mkPost()
    const op = await createPublishOp(sql, { post_id: p.id })
    // Simulate a failing op whose first_failed_at is > 24 h ago.
    await sql`
      UPDATE content.publish_ops
      SET first_failed_at = now() - interval '25 hours', status = 'failed'
      WHERE id = ${op.id}
    `
    const ops = await drainPublishOps(sql)
    expect(ops.map((o) => o.id)).not.toContain(op.id)
  })
})

// ── audit ─────────────────────────────────────────────────────────────────────
describe('recordContentAudit', () => {
  it('inserts an audit entry into content.content_audit (not outbox)', async () => {
    const p = await mkPost()
    await recordContentAudit(sql, { post_id: p.id, actor_sub: 'user-sub', action: 'publish.initiated' })
    const rows = await sql<{ post_id: string; actor_sub: string; action: string }[]>`
      SELECT post_id, actor_sub, action FROM content.content_audit
      WHERE post_id = ${p.id}
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actor_sub).toBe('user-sub')
    expect(rows[0]!.action).toBe('publish.initiated')
    // Verify the outbox is NOT polluted with audit entries
    const outboxRows = await sql<{ c: string }[]>`
      SELECT COUNT(*) AS c FROM outbox WHERE event_type = 'content_audit'
    `
    expect(Number(outboxRows[0]!.c)).toBe(0)
  })
})

// ── per-tenant isolation ──────────────────────────────────────────────────────
describe('per-tenant isolation', () => {
  it('a post in one tenant is not visible in another', async () => {
    const OTHER: TenantRef = { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', slug: 'othertenant' }
    const otherSql = await storeFor(OTHER, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })

    const p = await mkPost()

    // The other tenant's DB is completely separate; posts table is empty.
    const all = await listPosts(otherSql)
    expect(all.map((x) => x.id)).not.toContain(p.id)
  })
})
