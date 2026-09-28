/**
 * Integration tests for services/newsletter/src/store/*.ts
 *
 * Ports the SEMANTIC assertions from the SQLite test suites:
 *   - newsletter-db.test.ts
 *   - send-tokens-expiry.test.ts
 *   - unsubscribe-by-token.test.ts
 *   - scheduler-hygiene.test.ts (G-017 resetStuckSending)
 *
 * Must-cover contracts:
 *   - claimNewsletterForSending is ATOMIC under 2 concurrent claims (exactly one wins)
 *   - addUnsubscribeByToken: expired → {ok:false,reason:'expired'} + deletes token + no unsubscribe
 *   - addUnsubscribeByToken: invalid → {ok:false,reason:'invalid'}
 *   - updated_at bumps on UPDATE via the PG trigger
 *   - send-token default expires_at = now()+7d
 *   - purgeSendTokensOlderThan90Days
 *   - resetStuckSending (G-017)
 *
 * Fail-closed guard: refuses to run unless host is localhost/127.0.0.1
 * and all test DBs use the newsletter_test_ prefix.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { storeFor, _resetTenantStoreForTests, type TenantRef } from '../src/tenant-store.ts'
import {
  // lists
  createMailingList,
  listMailingLists,
  deleteMailingList,
  addMember,
  listMembers,
  deleteMember,
  countSubscribers,
  // newsletters
  createNewsletter,
  listNewsletters,
  getNewsletter,
  updateNewsletter,
  setNewsletterRecipients,
  getNewsletterRecipients,
  getScheduledDueNewsletters,
  claimNewsletterForSending,
  resetStuckSending,
  countNewsletterRecipients,
  // tokens
  addUnsubscribe,
  addUnsubscribeByToken,
  isUnsubscribed,
  addSendToken,
  purgeSendTokensOlderThan90Days,
  // audit
  recordNewsletterAudit,
} from '../src/store/index.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

// ── fail-closed guard (mirrors #249 / assert-safe-test-db-url pattern) ────────
const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'newsletter_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

// ── test tenant ───────────────────────────────────────────────────────────────
const STORE_TENANT: TenantRef = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  slug: 'storetest',
}

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
  sql = await storeFor(STORE_TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
})

afterAll(async () => {
  await _resetTenantStoreForTests()
  await dropTestDbs(admin)
  await admin.end()
})

// Clear all tables before each test for hermeticity.
beforeEach(async () => {
  // Delete in FK-safe order: children first.
  await sql`DELETE FROM newsletter_audit`
  await sql`DELETE FROM send_tokens`
  await sql`DELETE FROM unsubscribes`
  await sql`DELETE FROM newsletter_recipients`
  await sql`DELETE FROM deliveries`
  await sql`DELETE FROM outbox`
  await sql`DELETE FROM newsletters`
  await sql`DELETE FROM mailing_list_members`
  await sql`DELETE FROM mailing_lists`
})

// ── mailing lists ─────────────────────────────────────────────────────────────
describe('mailing lists', () => {
  it('creates and lists a mailing list', async () => {
    const list = await createMailingList(sql, 'AStA Verteiler')
    expect(list.id).toBeTypeOf('number')
    expect(list.name).toBe('AStA Verteiler')
    const all = await listMailingLists(sql)
    expect(all).toHaveLength(1)
  })

  it('deletes a mailing list and cascades members', async () => {
    const list = await createMailingList(sql, 'Test')
    await addMember(sql, list.id, 'a@b.de', null, 'manual')
    await deleteMailingList(sql, list.id)
    expect(await listMailingLists(sql)).toHaveLength(0)
    expect(await listMembers(sql, list.id)).toHaveLength(0)
  })
})

// ── members ───────────────────────────────────────────────────────────────────
describe('members', () => {
  it('adds and lists members', async () => {
    const list = await createMailingList(sql, 'Test')
    await addMember(sql, list.id, 'a@b.de', 'Anna', 'csv')
    const members = await listMembers(sql, list.id)
    expect(members).toHaveLength(1)
    expect(members[0]!.email).toBe('a@b.de')
    expect(members[0]!.source).toBe('csv')
  })

  it('ignores duplicate emails within same list', async () => {
    const list = await createMailingList(sql, 'Test')
    await addMember(sql, list.id, 'a@b.de', null, 'csv')
    await addMember(sql, list.id, 'a@b.de', null, 'manual') // duplicate — ignored
    expect(await listMembers(sql, list.id)).toHaveLength(1)
  })

  it('deletes a member', async () => {
    const list = await createMailingList(sql, 'Test')
    await addMember(sql, list.id, 'a@b.de', null, 'manual')
    const members = await listMembers(sql, list.id)
    await deleteMember(sql, members[0]!.id)
    expect(await listMembers(sql, list.id)).toHaveLength(0)
  })

  it('countSubscribers counts distinct emails across all lists', async () => {
    const l1 = await createMailingList(sql, 'L1')
    const l2 = await createMailingList(sql, 'L2')
    await addMember(sql, l1.id, 'shared@b.de', null, 'csv')
    await addMember(sql, l2.id, 'shared@b.de', null, 'csv') // same email on two lists
    await addMember(sql, l2.id, 'other@b.de', null, 'csv')
    const count = await countSubscribers(sql)
    expect(count).toBe(2)
  })
})

// ── newsletters ───────────────────────────────────────────────────────────────
describe('newsletters', () => {
  it('creates and retrieves a newsletter', async () => {
    const n = await createNewsletter(sql, {
      title: 'Ausgabe 1',
      odt_path: '/remote.php/dav/files/admin/_newsletters/ausgabe-1.odt',
      subject: 'Hallo!',
      created_by: 'user-uuid',
    })
    expect(n.status).toBe('draft')
    const got = await getNewsletter(sql, n.id)
    expect(got).toMatchObject({ title: 'Ausgabe 1' })
  })

  it('listNewsletters returns all newsletters', async () => {
    await createNewsletter(sql, { title: 'A', odt_path: '/a.odt', subject: 'S', created_by: 'u' })
    await createNewsletter(sql, { title: 'B', odt_path: '/b.odt', subject: 'S', created_by: 'u' })
    const all = await listNewsletters(sql)
    expect(all).toHaveLength(2)
  })

  it('getNewsletter returns null for missing id', async () => {
    const got = await getNewsletter(sql, 999999)
    expect(got).toBeNull()
  })

  it('updateNewsletter partial-sets fields', async () => {
    const n = await createNewsletter(sql, { title: 'T', odt_path: '/t.odt', subject: 'S', created_by: 'u' })
    await updateNewsletter(sql, n.id, { status: 'scheduled', scheduled_at: '2026-05-01T10:00:00Z' })
    const got = await getNewsletter(sql, n.id)
    expect(got!.status).toBe('scheduled')
  })

  it('updated_at bumps on UPDATE via the PG trigger', async () => {
    const n = await createNewsletter(sql, { title: 'T', odt_path: '/t.odt', subject: 'S', created_by: 'u' })
    const before = n.updated_at
    // Small delay to ensure timestamp changes.
    await new Promise((r) => setTimeout(r, 50))
    await updateNewsletter(sql, n.id, { status: 'scheduled', scheduled_at: '2099-01-01T00:00:00Z' })
    const after = await getNewsletter(sql, n.id)
    // updated_at must be strictly after the original value.
    expect(new Date(after!.updated_at).getTime()).toBeGreaterThan(new Date(before).getTime())
  })

  it('getScheduledDueNewsletters returns only due scheduled newsletters', async () => {
    const past = await createNewsletter(sql, { title: 'P', odt_path: '/p.odt', subject: 'S', created_by: 'u' })
    const future = await createNewsletter(sql, { title: 'F', odt_path: '/f.odt', subject: 'S', created_by: 'u' })
    await updateNewsletter(sql, past.id, { status: 'scheduled', scheduled_at: '2020-01-01T00:00:00Z' })
    await updateNewsletter(sql, future.id, { status: 'scheduled', scheduled_at: '2099-01-01T00:00:00Z' })
    const due = await getScheduledDueNewsletters(sql)
    expect(due.map((n) => n.id)).toContain(past.id)
    expect(due.map((n) => n.id)).not.toContain(future.id)
  })

  it('countNewsletterRecipients counts distinct member emails via mailing lists', async () => {
    const n = await createNewsletter(sql, { title: 'T', odt_path: '/t.odt', subject: 'S', created_by: 'u' })
    const l1 = await createMailingList(sql, 'L1')
    const l2 = await createMailingList(sql, 'L2')
    await addMember(sql, l1.id, 'a@b.de', null, 'csv')
    await addMember(sql, l1.id, 'b@b.de', null, 'csv')
    await addMember(sql, l2.id, 'a@b.de', null, 'csv') // same email on l2
    await setNewsletterRecipients(sql, n.id, [
      { mailing_list_id: l1.id },
      { mailing_list_id: l2.id },
    ])
    const count = await countNewsletterRecipients(sql, n.id)
    expect(count).toBe(2) // a@b.de counted once, b@b.de once
  })
})

// ── recipients ────────────────────────────────────────────────────────────────
describe('recipients', () => {
  it('sets and retrieves newsletter recipients', async () => {
    const n = await createNewsletter(sql, { title: 'T', odt_path: '/t.odt', subject: 'S', created_by: 'u' })
    const list = await createMailingList(sql, 'L')
    await setNewsletterRecipients(sql, n.id, [
      { mailing_list_id: list.id },
      { keycloak_group_id: 'group-uuid' },
    ])
    const recipients = await getNewsletterRecipients(sql, n.id)
    expect(recipients).toHaveLength(2)
  })

  it('setNewsletterRecipients replaces existing recipients', async () => {
    const n = await createNewsletter(sql, { title: 'T', odt_path: '/t.odt', subject: 'S', created_by: 'u' })
    const l1 = await createMailingList(sql, 'L1')
    const l2 = await createMailingList(sql, 'L2')
    await setNewsletterRecipients(sql, n.id, [{ mailing_list_id: l1.id }])
    await setNewsletterRecipients(sql, n.id, [{ mailing_list_id: l2.id }])
    const recipients = await getNewsletterRecipients(sql, n.id)
    expect(recipients).toHaveLength(1)
    expect(recipients[0]!.mailing_list_id).toBe(l2.id)
  })
})

// ── claimNewsletterForSending ─────────────────────────────────────────────────
describe('claimNewsletterForSending', () => {
  it('transitions draft→sending and returns true', async () => {
    const n = await createNewsletter(sql, { title: 'T', odt_path: '/t.odt', subject: 'S', created_by: 'u' })
    const claimed = await claimNewsletterForSending(sql, n.id)
    expect(claimed).toBe(true)
    const got = await getNewsletter(sql, n.id)
    expect(got!.status).toBe('sending')
  })

  it('returns false when already sending', async () => {
    const n = await createNewsletter(sql, { title: 'T', odt_path: '/t.odt', subject: 'S', created_by: 'u' })
    await claimNewsletterForSending(sql, n.id)
    const second = await claimNewsletterForSending(sql, n.id)
    expect(second).toBe(false)
  })

  it('returns false when already sent', async () => {
    const n = await createNewsletter(sql, { title: 'T', odt_path: '/t.odt', subject: 'S', created_by: 'u' })
    await updateNewsletter(sql, n.id, { status: 'sent' })
    const claimed = await claimNewsletterForSending(sql, n.id)
    expect(claimed).toBe(false)
  })

  it('returns false for a non-existent id', async () => {
    const claimed = await claimNewsletterForSending(sql, 999999)
    expect(claimed).toBe(false)
  })

  it('ATOMIC: under 2 concurrent claims exactly one wins', async () => {
    const n = await createNewsletter(sql, { title: 'T', odt_path: '/t.odt', subject: 'S', created_by: 'u' })
    // Fire both claims simultaneously.
    const [r1, r2] = await Promise.all([
      claimNewsletterForSending(sql, n.id),
      claimNewsletterForSending(sql, n.id),
    ])
    // Exactly one must be true; one must be false.
    const wins = [r1, r2].filter(Boolean)
    expect(wins).toHaveLength(1)
    // The status must be 'sending' (not double-written or reverted).
    const got = await getNewsletter(sql, n.id)
    expect(got!.status).toBe('sending')
  })
})

// ── resetStuckSending (G-017) ─────────────────────────────────────────────────
describe('resetStuckSending (G-017)', () => {
  it('resets newsletters stuck in sending longer than the cutoff', async () => {
    const n = await createNewsletter(sql, { title: 'Stuck', odt_path: '/s.odt', subject: 'S', created_by: 'u' })
    // Claim it (→sending) then manually age updated_at.
    await claimNewsletterForSending(sql, n.id)
    // Set updated_at to 2 hours ago so it falls within a 1-hour cutoff.
    await sql`UPDATE newsletters SET updated_at = now() - interval '2 hours' WHERE id = ${n.id}`
    const count = await resetStuckSending(sql, 60) // cutoff = 60 minutes
    expect(count).toBeGreaterThanOrEqual(1)
    const got = await getNewsletter(sql, n.id)
    expect(got!.status).toBe('failed')
  })

  it('does NOT reset newsletters stuck for less than the cutoff', async () => {
    const n = await createNewsletter(sql, { title: 'Fresh', odt_path: '/f.odt', subject: 'S', created_by: 'u' })
    await claimNewsletterForSending(sql, n.id)
    // updated_at was just bumped by the claim — well within 60 min.
    const count = await resetStuckSending(sql, 60)
    expect(count).toBe(0)
    const got = await getNewsletter(sql, n.id)
    expect(got!.status).toBe('sending')
  })
})

// ── unsubscribes ──────────────────────────────────────────────────────────────
describe('unsubscribes', () => {
  it('addUnsubscribe records unsubscribe and isUnsubscribed detects it', async () => {
    await addUnsubscribe(sql, 'a@b.de', 'token-uuid')
    expect(await isUnsubscribed(sql, 'a@b.de')).toBe(true)
    expect(await isUnsubscribed(sql, 'other@b.de')).toBe(false)
  })

  it('addUnsubscribe is idempotent (duplicate ignored)', async () => {
    await addUnsubscribe(sql, 'a@b.de', 'tok-1')
    // A second call with the same email should not throw (ON CONFLICT DO NOTHING on email PK).
    await expect(addUnsubscribe(sql, 'a@b.de', 'tok-2')).resolves.not.toThrow()
    expect(await isUnsubscribed(sql, 'a@b.de')).toBe(true)
  })
})

// ── addUnsubscribeByToken (G-009 route half) ───────────────────────────────────
describe('addUnsubscribeByToken (G-009 route half)', () => {
  it('valid token: returns {ok:true}, inserts unsubscribe, deletes token', async () => {
    const n = await createNewsletter(sql, { title: 'T', odt_path: '/t.odt', subject: 'S', created_by: 'u' })
    await addSendToken(sql, 'tok-valid', n.id, 'a@b.de')

    const result = await addUnsubscribeByToken(sql, 'tok-valid')

    expect(result).toEqual({ ok: true })
    expect(await isUnsubscribed(sql, 'a@b.de')).toBe(true)
    // Token consumed.
    const rows = await sql<{ c: number }[]>`SELECT COUNT(*) AS c FROM send_tokens WHERE token = 'tok-valid'`
    expect(Number(rows[0]!.c)).toBe(0)
    // unsubscribes row has correct fields.
    const row = await sql<{ email: string; token: string }[]>`SELECT email, token FROM unsubscribes WHERE email = 'a@b.de'`
    expect(row[0]!.email).toBe('a@b.de')
    expect(row[0]!.token).toBe('tok-valid')
  })

  it('expired token: returns {ok:false,reason:"expired"}, deletes token, does NOT unsubscribe', async () => {
    const n = await createNewsletter(sql, { title: 'T', odt_path: '/t.odt', subject: 'S', created_by: 'u' })
    // Insert a token with a past expiry.
    await sql`INSERT INTO send_tokens (token, newsletter_id, email, expires_at) VALUES ('tok-expired', ${n.id}, 'expired@b.de', now() - interval '1 day')`

    const result = await addUnsubscribeByToken(sql, 'tok-expired')

    expect(result).toEqual({ ok: false, reason: 'expired' })
    // Token deleted.
    const rows = await sql<{ c: number }[]>`SELECT COUNT(*) AS c FROM send_tokens WHERE token = 'tok-expired'`
    expect(Number(rows[0]!.c)).toBe(0)
    // No unsubscribe recorded.
    expect(await isUnsubscribed(sql, 'expired@b.de')).toBe(false)
  })

  it('unknown token: returns {ok:false,reason:"invalid"}, makes no changes', async () => {
    const result = await addUnsubscribeByToken(sql, 'tok-unknown')
    expect(result).toEqual({ ok: false, reason: 'invalid' })
    expect(await isUnsubscribed(sql, 'anyone@b.de')).toBe(false)
  })

  it('replay attack: second call with same token reports invalid', async () => {
    const n = await createNewsletter(sql, { title: 'T', odt_path: '/t.odt', subject: 'S', created_by: 'u' })
    await addSendToken(sql, 'tok-replay', n.id, 'replay@b.de')

    const first = await addUnsubscribeByToken(sql, 'tok-replay')
    const second = await addUnsubscribeByToken(sql, 'tok-replay')

    expect(first).toEqual({ ok: true })
    expect(second).toEqual({ ok: false, reason: 'invalid' })
    // Exactly one unsubscribe row.
    const rows = await sql<{ c: number }[]>`SELECT COUNT(*) AS c FROM unsubscribes WHERE email = 'replay@b.de'`
    expect(Number(rows[0]!.c)).toBe(1)
  })
})

// ── send tokens (G-009 schema half) ───────────────────────────────────────────
describe('send_tokens (G-009 schema)', () => {
  it('addSendToken default expires_at ≈ now()+7d', async () => {
    const n = await createNewsletter(sql, { title: 'T', odt_path: '/t.odt', subject: 'S', created_by: 'u' })
    const before = Date.now()
    await addSendToken(sql, 'tok-fresh', n.id, 'a@b.de')
    const rows = await sql<{ expires_at: Date }[]>`SELECT expires_at FROM send_tokens WHERE token = 'tok-fresh'`
    expect(rows).toHaveLength(1)
    const expiresAt = rows[0]!.expires_at
    const expected7d = before + 7 * 24 * 60 * 60 * 1000
    // Allow ±60 seconds tolerance.
    expect(Math.abs(expiresAt.getTime() - expected7d)).toBeLessThan(60_000)
  })

  it('addSendToken returns the persisted token (reuse on conflict)', async () => {
    const n = await createNewsletter(sql, { title: 'T', odt_path: '/t.odt', subject: 'S', created_by: 'u' })
    const first = await addSendToken(sql, 'tok-orig', n.id, 'a@b.de')
    // Second call with a different token but same (newsletter_id, email) → conflict; must return 'tok-orig'.
    const second = await addSendToken(sql, 'tok-new', n.id, 'a@b.de')
    expect(first).toBe('tok-orig')
    expect(second).toBe('tok-orig')
  })

  it('purgeSendTokensOlderThan90Days removes tokens for newsletters sent >90d ago', async () => {
    const n = await createNewsletter(sql, { title: 'T', odt_path: '/t.odt', subject: 'S', created_by: 'u' })
    // Set sent_at to 91 days ago.
    await sql`UPDATE newsletters SET sent_at = now() - interval '91 days' WHERE id = ${n.id}`
    await addSendToken(sql, 'tok-old', n.id, 'a@b.de')

    await purgeSendTokensOlderThan90Days(sql)

    const rows = await sql<{ c: number }[]>`SELECT COUNT(*) AS c FROM send_tokens`
    expect(Number(rows[0]!.c)).toBe(0)
  })

  it('purgeSendTokensOlderThan90Days keeps tokens for recently sent newsletters', async () => {
    const n = await createNewsletter(sql, { title: 'T', odt_path: '/t.odt', subject: 'S', created_by: 'u' })
    await sql`UPDATE newsletters SET sent_at = now() - interval '10 days' WHERE id = ${n.id}`
    await addSendToken(sql, 'tok-recent', n.id, 'a@b.de')

    await purgeSendTokensOlderThan90Days(sql)

    const rows = await sql<{ c: number }[]>`SELECT COUNT(*) AS c FROM send_tokens`
    expect(Number(rows[0]!.c)).toBe(1)
  })
})

// ── audit ─────────────────────────────────────────────────────────────────────
describe('recordNewsletterAudit', () => {
  it('inserts an audit row', async () => {
    const n = await createNewsletter(sql, { title: 'T', odt_path: '/t.odt', subject: 'S', created_by: 'u' })
    await recordNewsletterAudit(sql, n.id, 'user-sub', 'send.initiated')
    const rows = await sql<{ newsletter_id: number; actor_sub: string; action: string }[]>`
      SELECT newsletter_id, actor_sub, action FROM newsletter_audit WHERE newsletter_id = ${n.id}
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actor_sub).toBe('user-sub')
    expect(rows[0]!.action).toBe('send.initiated')
  })
})
