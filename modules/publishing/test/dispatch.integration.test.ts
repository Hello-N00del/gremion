/**
 * Integration tests for the dispatch engine (Task 8 — send pipeline).
 *
 * Runs against a real disposable Postgres (NEWSLETTER_TEST_PG_URL). The send
 * transport AND the kernel client are FAKES injected into dispatch() — no live
 * kernel, no live SMTP. The deliveries ledger (claimRecipient/markSent) is the
 * REAL Postgres-backed gate, so the duplicate-send proof exercises the actual
 * concurrency semantics.
 *
 * THE DoD-c PROOF lives here: 'duplicate dispatch sends one message per recipient'.
 *
 * Fail-closed guard mirrors deliveries.integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { storeFor, _resetTenantStoreForTests, type TenantRef } from '../src/tenant-store.ts'
import {
  createNewsletter,
  setNewsletterRecipients,
  createMailingList,
  addMember,
  addUnsubscribe,
  getNewsletter,
} from '../src/store/index.ts'
import { dispatch, type MailTransport, type SentMessage } from '../src/dispatch.ts'
import { MailUnconfiguredError, type KernelClient, type Recipient } from '../src/kernel-client.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

// ── fail-closed guard ─────────────────────────────────────────────────────────
const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'newsletter_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

const DISPATCH_TENANT: TenantRef = {
  id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  slug: 'disptest',
}
const ACTOR = 'dispatch-actor'

// ── fakes ───────────────────────────────────────────────────────────────────
/** A fake transport that records every sendMail call and counts per-recipient. */
function makeFakeTransport(opts: { failFor?: Set<string> } = {}): MailTransport & {
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
    async sendMail(msg): Promise<SentMessage> {
      if (opts.failFor?.has(msg.to)) {
        throw new Error(`fake SMTP failure for ${msg.to}`)
      }
      sent.push({ to: msg.to, subject: msg.subject, html: msg.html })
      seq += 1
      return { messageId: `<fake-${seq}@test>` }
    },
  }
}

/** A fake kernel client. render returns canned HTML; resolveGroup returns a map.
 *  sendMail is present to satisfy the KernelClient port (Option B2) but dispatch
 *  sends through the injected `transport`, not kernel.sendMail directly, so these
 *  tests assert on the transport fake. */
function makeFakeKernel(opts: {
  html?: string
  groups?: Record<string, Recipient[]>
  renderThrows?: boolean
} = {}): KernelClient {
  return {
    async render(): Promise<string> {
      if (opts.renderThrows) throw new Error('fake kernel render failure')
      return opts.html ?? '<html><body>Hi</body></html>'
    },
    async resolveGroup(groupId: string): Promise<Recipient[]> {
      return opts.groups?.[groupId] ?? []
    },
    async sendMail(msg): Promise<{ messageId: string }> {
      return { messageId: `<fake-kernel-${msg.to}@test>` }
    },
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
  sql = await storeFor(DISPATCH_TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
})

afterAll(async () => {
  await _resetTenantStoreForTests()
  await dropTestDbs(admin)
  await admin.end()
})

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
async function makeNewsletterWithList(
  emails: string[],
): Promise<{ nlId: number; listId: number }> {
  const nl = await createNewsletter(sql, {
    title: 'NL', odt_path: '/n.odt', subject: 'Subject', created_by: ACTOR,
  })
  const list = await createMailingList(sql, 'L1')
  for (const e of emails) await addMember(sql, list.id, e, null, 'manual')
  await setNewsletterRecipients(sql, nl.id, [{ mailing_list_id: list.id }])
  return { nlId: nl.id, listId: list.id }
}

async function outboxRows(): Promise<
  Array<{ event_type: string; payload: Record<string, unknown>; correlation_id: string | null }>
> {
  return sql<{ event_type: string; payload: Record<string, unknown>; correlation_id: string | null }[]>`
    SELECT event_type, payload, correlation_id FROM outbox ORDER BY created_at
  `
}

// ── happy path ─────────────────────────────────────────────────────────────────
describe('dispatch — happy path', () => {
  it('sends to every recipient, writes deliveries+tokens+status sent + one send.succeeded outbox row', async () => {
    const { nlId } = await makeNewsletterWithList(['alice@x.com', 'bob@x.com'])
    const transport = makeFakeTransport()
    const kernel = makeFakeKernel()

    await dispatch(DISPATCH_TENANT, nlId, ACTOR, {
      sql, kernel, transport, origin: 'https://disptest.example',
    })

    expect(transport.sent).toHaveLength(2)
    expect(transport.countFor('alice@x.com')).toBe(1)
    expect(transport.countFor('bob@x.com')).toBe(1)

    const nl = await getNewsletter(sql, nlId)
    expect(nl!.status).toBe('sent')
    expect(nl!.sent_at).not.toBeNull()

    // deliveries: both 'sent'
    const dels = await sql<{ email: string; status: string }[]>`
      SELECT email, status FROM deliveries WHERE newsletter_id = ${nlId} ORDER BY email`
    expect(dels.map((d) => d.status)).toEqual(['sent', 'sent'])

    // tokens minted for each
    const toks = await sql<{ c: string }[]>`
      SELECT count(*) AS c FROM send_tokens WHERE newsletter_id = ${nlId}`
    expect(Number(toks[0]!.c)).toBe(2)

    // exactly one outbox row, send.succeeded, with the documented payload shape
    const rows = await outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event_type).toBe('send.succeeded')
    expect(rows[0]!.correlation_id).toBe(String(nlId))
    expect(rows[0]!.payload).toMatchObject({
      newsletterId: nlId, recipientCount: 2, deliveredCount: 2, actor: ACTOR,
    })
  })

  it('injects the unsubscribe footer with a per-recipient token into the sent html', async () => {
    const { nlId } = await makeNewsletterWithList(['alice@x.com'])
    const transport = makeFakeTransport()
    await dispatch(DISPATCH_TENANT, nlId, ACTOR, {
      sql, kernel: makeFakeKernel({ html: '<html><body>Body</body></html>' }),
      transport, origin: 'https://disptest.example',
    })
    expect(transport.sent[0]!.html).toContain('unsubscribe?token=')
    expect(transport.sent[0]!.html).toContain('https://disptest.example')
  })
})

// ── recipient assembly (buildRecipientList port) ────────────────────────────────
describe('dispatch — recipient assembly', () => {
  it('dedupes across lists+groups and filters unsubscribed (lowercased)', async () => {
    const nl = await createNewsletter(sql, {
      title: 'NL', odt_path: '/n.odt', subject: 'S', created_by: ACTOR,
    })
    const list = await createMailingList(sql, 'L')
    await addMember(sql, list.id, 'Alice@X.com', 'Alice', 'manual')
    await addMember(sql, list.id, 'dup@x.com', null, 'manual')
    await addUnsubscribe(sql, 'gone@x.com', 'tok-gone')
    await setNewsletterRecipients(sql, nl.id, [
      { mailing_list_id: list.id },
      { keycloak_group_id: 'grp-1' },
    ])

    const transport = makeFakeTransport()
    const kernel = makeFakeKernel({
      groups: { 'grp-1': [
        { email: 'DUP@x.com', name: 'Dup2' },   // duplicate (case-insensitive) of dup@x.com
        { email: 'gone@x.com', name: 'Gone' },   // unsubscribed → filtered
        { email: 'carol@x.com', name: 'Carol' }, // new
      ] },
    })

    await dispatch(DISPATCH_TENANT, nl.id, ACTOR, {
      sql, kernel, transport, origin: 'https://o',
    })

    const tos = transport.sent.map((m) => m.to).sort()
    // alice (lowercased), dup (once), carol — gone filtered, DUP deduped
    expect(tos).toEqual(['alice@x.com', 'carol@x.com', 'dup@x.com'])
  })
})

// ── kernel render failure → failed + send.failed outbox ─────────────────────────
describe('dispatch — kernel render failure', () => {
  it('marks status failed and enqueues a send.failed outbox row; no messages sent', async () => {
    const { nlId } = await makeNewsletterWithList(['alice@x.com'])
    const transport = makeFakeTransport()
    const kernel = makeFakeKernel({ renderThrows: true })

    await expect(
      dispatch(DISPATCH_TENANT, nlId, ACTOR, { sql, kernel, transport, origin: 'https://o' }),
    ).rejects.toThrow()

    expect(transport.sent).toHaveLength(0)
    const nl = await getNewsletter(sql, nlId)
    expect(nl!.status).toBe('failed')
    expect(nl!.error).toBeTruthy()

    const rows = await outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event_type).toBe('send.failed')
  })
})

// ── per-recipient SMTP failure → partial, failed status, bounded at-least-once ──
describe('dispatch — per-recipient SMTP failure', () => {
  it('sends the good ones, marks failed, leaves the failed recipient claimed (retry after staleness)', async () => {
    const { nlId } = await makeNewsletterWithList(['ok@x.com', 'bad@x.com'])
    const transport = makeFakeTransport({ failFor: new Set(['bad@x.com']) })

    await expect(
      dispatch(DISPATCH_TENANT, nlId, ACTOR, {
        sql, kernel: makeFakeKernel(), transport, origin: 'https://o',
      }),
    ).rejects.toThrow()

    expect(transport.countFor('ok@x.com')).toBe(1)
    expect(transport.countFor('bad@x.com')).toBe(0)

    const dels = await sql<{ email: string; status: string }[]>`
      SELECT email, status FROM deliveries WHERE newsletter_id = ${nlId} ORDER BY email`
    // ok→sent, bad→claimed (still held; bounded at-least-once via 15-min stale takeover)
    expect(dels.find((d) => d.email === 'ok@x.com')!.status).toBe('sent')
    expect(dels.find((d) => d.email === 'bad@x.com')!.status).toBe('claimed')

    const nl = await getNewsletter(sql, nlId)
    expect(nl!.status).toBe('failed')

    const rows = await outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event_type).toBe('send.failed')
  })
})

// ── kernel send-mail unconfigured (Option B2) → failed + send.failed ────────────
describe('dispatch — kernel send-mail unconfigured (Option B2)', () => {
  it('a MailUnconfiguredError from the kernel-backed transport → newsletter failed + send.failed outbox (not a crash)', async () => {
    const { nlId } = await makeNewsletterWithList(['alice@x.com'])
    // The production transport delegates to kernel.sendMail; the kernel returns
    // 503 smtp-unconfigured → the client throws MailUnconfiguredError. Model that
    // here as a transport that throws the same typed error.
    const transport: MailTransport = {
      async sendMail(): Promise<SentMessage> {
        throw new MailUnconfiguredError('kernel send-mail: tenant SMTP not configured (to=alice@x.com)')
      },
    }

    await expect(
      dispatch(DISPATCH_TENANT, nlId, ACTOR, {
        sql, kernel: makeFakeKernel(), transport, origin: 'https://o',
      }),
    ).rejects.toThrow() // surfaced to the caller, but as a clean 'failed', not an unhandled crash

    const nl = await getNewsletter(sql, nlId)
    expect(nl!.status).toBe('failed')
    expect(nl!.error).toBeTruthy()

    // claim left in place (no markSent) — bounded at-least-once, retry after staleness
    const dels = await sql<{ email: string; status: string }[]>`
      SELECT email, status FROM deliveries WHERE newsletter_id = ${nlId}`
    expect(dels.find((d) => d.email === 'alice@x.com')!.status).toBe('claimed')

    const rows = await outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event_type).toBe('send.failed')
  })
})

// ── THE DoD-c PROOF ─────────────────────────────────────────────────────────────
describe('DoD-c — duplicate-send prevention', () => {
  it('duplicate dispatch sends one message per recipient', async () => {
    const recipients = ['alice@x.com', 'bob@x.com', 'carol@x.com']
    const { nlId } = await makeNewsletterWithList(recipients)

    // ONE shared transport across all dispatches so we can count globally.
    const transport = makeFakeTransport()
    const run = () =>
      dispatch(DISPATCH_TENANT, nlId, ACTOR, {
        sql, kernel: makeFakeKernel(), transport, origin: 'https://o',
      }).catch(() => {/* a loser of the newsletter-level claim is a no-op */})

    // CONCURRENT: fire two dispatches of the SAME newsletter at once.
    await Promise.all([run(), run()])
    // SEQUENTIAL: a third dispatch after the first completed.
    await run()

    // EXACTLY ONE message per recipient across all three dispatches.
    for (const r of recipients) {
      expect(transport.countFor(r)).toBe(1)
    }
    expect(transport.sent).toHaveLength(recipients.length)
  })

  it('crash between claim and markSent → re-dispatch after staleness re-sends only that recipient', async () => {
    const recipients = ['alice@x.com', 'bob@x.com', 'carol@x.com']
    const { nlId } = await makeNewsletterWithList(recipients)

    // First dispatch: alice & carol succeed, bob "crashes" (transport throws),
    // so bob's claim is left 'claimed' (no markSent).
    const t1 = makeFakeTransport({ failFor: new Set(['bob@x.com']) })
    await dispatch(DISPATCH_TENANT, nlId, ACTOR, {
      sql, kernel: makeFakeKernel(), transport: t1, origin: 'https://o',
    }).catch(() => {})
    expect(t1.countFor('alice@x.com')).toBe(1)
    expect(t1.countFor('carol@x.com')).toBe(1)
    expect(t1.countFor('bob@x.com')).toBe(0)

    // Age bob's claim past the 15-min stale window so a re-dispatch can take it over.
    await sql`
      UPDATE deliveries SET claimed_at = now() - interval '20 minutes'
      WHERE newsletter_id = ${nlId} AND email = 'bob@x.com' AND status = 'claimed'`
    // The newsletter is 'failed' now → re-claimable.

    // Re-dispatch with a fresh transport: only bob should be re-sent.
    const t2 = makeFakeTransport()
    await dispatch(DISPATCH_TENANT, nlId, ACTOR, {
      sql, kernel: makeFakeKernel(), transport: t2, origin: 'https://o',
    })
    expect(t2.countFor('bob@x.com')).toBe(1)
    expect(t2.countFor('alice@x.com')).toBe(0)
    expect(t2.countFor('carol@x.com')).toBe(0)

    const nl = await getNewsletter(sql, nlId)
    expect(nl!.status).toBe('sent')
  })
})
