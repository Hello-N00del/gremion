/**
 * Integration tests for claimRecipient / markSent (Task 6 — deliveries ledger).
 *
 * DoD-c gate: duplicate-send prevention.
 *
 * Fail-closed guard: refuses to run unless host is localhost/127.0.0.1
 * and all test DBs use the newsletter_test_ prefix (mirrors store.integration.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { storeFor, _resetTenantStoreForTests, type TenantRef } from '../src/tenant-store.ts'
import { createNewsletter } from '../src/store/index.ts'
import { claimRecipient, markSent } from '../src/store/deliveries.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

// ── fail-closed guard ─────────────────────────────────────────────────────────
const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'newsletter_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

// ── test tenant ───────────────────────────────────────────────────────────────
const DELIVERIES_TENANT: TenantRef = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  slug: 'delivtest',
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
  sql = await storeFor(DELIVERIES_TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
})

afterAll(async () => {
  await _resetTenantStoreForTests()
  await dropTestDbs(admin)
  await admin.end()
})

// Clear tables before each test (FK-safe order).
beforeEach(async () => {
  await sql`DELETE FROM deliveries`
  await sql`DELETE FROM newsletter_audit`
  await sql`DELETE FROM send_tokens`
  await sql`DELETE FROM unsubscribes`
  await sql`DELETE FROM newsletter_recipients`
  await sql`DELETE FROM outbox`
  await sql`DELETE FROM newsletters`
  await sql`DELETE FROM mailing_list_members`
  await sql`DELETE FROM mailing_lists`
})

// ── helpers ───────────────────────────────────────────────────────────────────
async function makeNewsletter(): Promise<number> {
  const n = await createNewsletter(sql, {
    title: 'Test NL',
    odt_path: '/test.odt',
    subject: 'Test',
    created_by: 'test-user',
  })
  return n.id
}

// ── claimRecipient: basic ─────────────────────────────────────────────────────
describe('claimRecipient — basic', () => {
  it("first claim returns 'fresh'", async () => {
    const nlId = await makeNewsletter()
    const result = await claimRecipient(sql, nlId, 'alice@example.com')
    expect(result).toBe('fresh')
  })

  it("second claim (before markSent) returns 'in-flight'", async () => {
    const nlId = await makeNewsletter()
    await claimRecipient(sql, nlId, 'alice@example.com')
    const second = await claimRecipient(sql, nlId, 'alice@example.com')
    expect(second).toBe('in-flight')
  })

  it("claim after markSent returns 'already-sent'", async () => {
    const nlId = await makeNewsletter()
    await claimRecipient(sql, nlId, 'alice@example.com')
    await markSent(sql, nlId, 'alice@example.com', '<msg-id-1@example.com>')
    const third = await claimRecipient(sql, nlId, 'alice@example.com')
    expect(third).toBe('already-sent')
  })

  it('different emails on same newsletter are independent', async () => {
    const nlId = await makeNewsletter()
    const r1 = await claimRecipient(sql, nlId, 'alice@example.com')
    const r2 = await claimRecipient(sql, nlId, 'bob@example.com')
    expect(r1).toBe('fresh')
    expect(r2).toBe('fresh')
  })

  it('same email on different newsletters are independent', async () => {
    const nl1 = await makeNewsletter()
    const nl2 = await makeNewsletter()
    const r1 = await claimRecipient(sql, nl1, 'alice@example.com')
    const r2 = await claimRecipient(sql, nl2, 'alice@example.com')
    expect(r1).toBe('fresh')
    expect(r2).toBe('fresh')
  })
})

// ── markSent ──────────────────────────────────────────────────────────────────
describe('markSent', () => {
  it('sets status to sent and records smtp_message_id + sent_at', async () => {
    const nlId = await makeNewsletter()
    await claimRecipient(sql, nlId, 'alice@example.com')
    await markSent(sql, nlId, 'alice@example.com', '<msg-id@example.com>')

    const rows = await sql<
      { status: string; smtp_message_id: string; sent_at: Date }[]
    >`SELECT status, smtp_message_id, sent_at FROM deliveries
      WHERE newsletter_id = ${nlId} AND email = 'alice@example.com'`

    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('sent')
    expect(rows[0]!.smtp_message_id).toBe('<msg-id@example.com>')
    expect(rows[0]!.sent_at).not.toBeNull()
  })
})

// ── stale claim takeover ──────────────────────────────────────────────────────
describe('stale claim takeover', () => {
  it("reclaims a stale 'claimed' row (older than STALE_CLAIM_MINUTES) atomically", async () => {
    const nlId = await makeNewsletter()
    // First claim — creates the row.
    const first = await claimRecipient(sql, nlId, 'alice@example.com')
    expect(first).toBe('fresh')

    // Age the claimed_at to 20 minutes ago (past the 15-minute staleness window).
    await sql`
      UPDATE deliveries
      SET claimed_at = now() - interval '20 minutes'
      WHERE newsletter_id = ${nlId} AND email = 'alice@example.com'
    `

    // Stale takeover: second claim should return 'fresh' (took over).
    const second = await claimRecipient(sql, nlId, 'alice@example.com')
    expect(second).toBe('fresh')
  })

  it('stale takeover works exactly once under 2 concurrent takeover attempts', async () => {
    const nlId = await makeNewsletter()
    // Seed a stale 'claimed' row (20 min old).
    await sql`
      INSERT INTO deliveries (newsletter_id, email, status, claimed_at)
      VALUES (${nlId}, 'stale@example.com', 'claimed', now() - interval '20 minutes')
    `

    // Fire 2 concurrent takeover attempts — only one should win.
    const [r1, r2] = await Promise.all([
      claimRecipient(sql, nlId, 'stale@example.com'),
      claimRecipient(sql, nlId, 'stale@example.com'),
    ])

    const freshCount = [r1, r2].filter((r) => r === 'fresh').length
    const inFlightCount = [r1, r2].filter((r) => r === 'in-flight').length

    // Exactly one wins the stale takeover ('fresh'); the other sees a non-stale
    // claimed row and returns 'in-flight'.
    expect(freshCount).toBe(1)
    expect(inFlightCount).toBe(1)
  })
})

// ── DoD-c: re-dispatch sends only to unsent recipients ───────────────────────
describe('DoD-c — deliveries ledger', () => {
  it('re-dispatch sends only to unsent recipients', async () => {
    const nlId = await makeNewsletter()
    const recipients = [
      'alice@example.com',
      'bob@example.com',
      'carol@example.com',
      'dave@example.com',
    ]

    // Simulate first dispatch: claim all, but only send to alice and bob.
    for (const email of recipients) {
      await claimRecipient(sql, nlId, email)
    }
    await markSent(sql, nlId, 'alice@example.com', '<msg-alice@example.com>')
    await markSent(sql, nlId, 'bob@example.com', '<msg-bob@example.com>')
    // carol and dave remain 'claimed' (in-flight, unsent).

    // Age carol's and dave's claimed_at so the re-dispatch can take them over.
    await sql`
      UPDATE deliveries
      SET claimed_at = now() - interval '20 minutes'
      WHERE newsletter_id = ${nlId} AND email IN ('carol@example.com', 'dave@example.com')
    `

    // Re-dispatch: simulate sending loop calling claimRecipient for each recipient.
    const claimResults = await Promise.all(
      recipients.map(async (email) => ({
        email,
        result: await claimRecipient(sql, nlId, email),
      })),
    )

    // alice and bob should be 'already-sent' (do not re-send).
    const aliceResult = claimResults.find((r) => r.email === 'alice@example.com')!
    const bobResult = claimResults.find((r) => r.email === 'bob@example.com')!
    expect(aliceResult.result).toBe('already-sent')
    expect(bobResult.result).toBe('already-sent')

    // carol and dave should be 'fresh' (stale takeover — can re-send).
    const carolResult = claimResults.find((r) => r.email === 'carol@example.com')!
    const daveResult = claimResults.find((r) => r.email === 'dave@example.com')!
    expect(carolResult.result).toBe('fresh')
    expect(daveResult.result).toBe('fresh')

    // The re-dispatch only sends to the 'fresh' recipients.
    const toSend = claimResults.filter((r) => r.result === 'fresh').map((r) => r.email)
    expect(toSend).toHaveLength(2)
    expect(toSend).toContain('carol@example.com')
    expect(toSend).toContain('dave@example.com')
    expect(toSend).not.toContain('alice@example.com')
    expect(toSend).not.toContain('bob@example.com')
  })
})
