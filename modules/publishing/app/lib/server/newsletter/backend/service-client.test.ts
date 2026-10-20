// @vitest-environment node
// gremion-ui/src/lib/server/newsletter/backend/service-client.test.ts
// Task 14 — TDD test suite for ServiceNewsletterClient.
//
// Runs in the `node` environment (not the suite-default jsdom): this is a
// pure server-side client driving a real node:http stub via the native undici
// `fetch`. Under jsdom, the installed AbortController/AbortSignal globals are a
// DIFFERENT realm than the one undici's fetch closed over, so the client's
// `new AbortController().signal` is rejected with
// "RequestInit: Expected signal ... to be an instance of AbortSignal". The
// `node` env leaves the native fetch/AbortSignal pair intact (matching the many
// other server-only specs that use this same pragma). No DOM is used here.
//
// Strategy: spin up a real node:http stub server per test suite; point
// NEWSLETTER_SERVICE_URL at it; assert header forwarding, error mapping,
// and retry behaviour. The stub captures every request so assertions are
// deterministic without any real network I/O.
//
// RED: written BEFORE service-client.ts exists → import fails → all FAIL.
// GREEN: service-client.ts implemented → all PASS.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Server } from 'node:http'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'
import { ServiceNewsletterClient, NotSupportedViaServiceError, NewsletterServiceError } from './service-client'
import type { NewsletterBackendPort } from './port'

// ── Fake tenant context ──────────────────────────────────────────────────────
const FAKE_TENANT: TenantContext = {
  id: 'tenant-uuid-test',
  slug: 'test-tenant',
} as unknown as TenantContext

// ── Shared stub server state ─────────────────────────────────────────────────

interface CapturedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

interface StubBehaviour {
  /** Status to return on the FIRST call to this handler (default 200). */
  firstStatus?: number
  /** Status to return on subsequent calls (default firstStatus). */
  subsequentStatus?: number
  /** JSON body to return (default {}). */
  body?: unknown
  /** Call counter — incremented by the stub handler. */
  callCount: number
}

let server: Server
let port: number
let lastRequest: CapturedRequest | null = null
let stubBehaviour: StubBehaviour = { callCount: 0 }

function resetStub(opts: Omit<StubBehaviour, 'callCount'> = {}) {
  lastRequest = null
  stubBehaviour = { callCount: 0, ...opts }
}

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    stubBehaviour.callCount++
    const callIdx = stubBehaviour.callCount

    // Collect body
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    const rawBody = Buffer.concat(chunks).toString('utf8')
    let parsedBody: unknown = undefined
    if (rawBody) {
      try { parsedBody = JSON.parse(rawBody) } catch { parsedBody = rawBody }
    }

    // Capture the request
    lastRequest = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: parsedBody,
    }

    const status = callIdx === 1
      ? (stubBehaviour.firstStatus ?? 200)
      : (stubBehaviour.subsequentStatus ?? stubBehaviour.firstStatus ?? 200)

    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(stubBehaviour.body ?? {}))
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  )
})

// ── Set environment before each test ────────────────────────────────────────
beforeEach(() => {
  process.env.NEWSLETTER_SERVICE_URL = `http://127.0.0.1:${port}`
  process.env.INTERNAL_NEWSLETTER_SECRET = 'test-secret-1234'
  resetStub({ body: { success: true, data: [] } })
})

// ── Helper: run inside tenant context ────────────────────────────────────────
function withTenant<T>(fn: () => T): T {
  return runWithTenant(FAKE_TENANT, fn)
}

// ═══════════════════════════════════════════════════════════════════════════════
// Header forwarding
// ═══════════════════════════════════════════════════════════════════════════════

describe('ServiceNewsletterClient — header forwarding', () => {
  it('forwards x-tenant-id, x-tenant-slug, and x-internal-auth on every request', async () => {
    resetStub({ body: { success: true, data: [] } })
    const client: NewsletterBackendPort = new ServiceNewsletterClient()
    await withTenant(() => client.listNewsletters())
    expect(lastRequest).not.toBeNull()
    expect(lastRequest!.headers['x-tenant-id']).toBe('tenant-uuid-test')
    expect(lastRequest!.headers['x-tenant-slug']).toBe('test-tenant')
    expect(lastRequest!.headers['x-internal-auth']).toBe('test-secret-1234')
  })

  it('forwards x-correlation-id when provided in constructor', async () => {
    resetStub({ body: { success: true, data: [] } })
    const client = new ServiceNewsletterClient({ correlationId: 'corr-xyz' })
    await withTenant(() => client.listNewsletters())
    expect(lastRequest!.headers['x-correlation-id']).toBe('corr-xyz')
  })

  it('omits x-correlation-id when not provided', async () => {
    resetStub({ body: { success: true, data: [] } })
    const client = new ServiceNewsletterClient()
    await withTenant(() => client.listNewsletters())
    expect(lastRequest!.headers['x-correlation-id']).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Error mapping
// ═══════════════════════════════════════════════════════════════════════════════

describe('ServiceNewsletterClient — error mapping', () => {
  it('throws NewsletterServiceError with status 404 when leaf returns 404 (non-getNewsletter endpoint)', async () => {
    // getNewsletter maps 404 → null (port contract); for other endpoints 404 propagates as error.
    // Use listMembers on a non-existent list to test generic 404 propagation.
    resetStub({ firstStatus: 404, body: { success: false, error: 'List not found' } })
    const client = new ServiceNewsletterClient()
    await expect(withTenant(() => client.listMembers(9999))).rejects.toSatisfy(
      (e: unknown) => e instanceof NewsletterServiceError && e.status === 404
    )
  })

  it('throws NewsletterServiceError with status 409 when leaf returns 409', async () => {
    resetStub({ firstStatus: 409, body: { success: false, error: 'Already sending' } })
    const client = new ServiceNewsletterClient()
    await expect(
      withTenant(() => client.dispatchNow(1, 'actor', async () => []))
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof NewsletterServiceError && e.status === 409
    )
  })

  it('does NOT throw 410 for consumeUnsubscribeToken — maps it to {ok:false,reason} (F-LOW)', async () => {
    // The leaf protocol returns HTTP 200 + {ok:false,reason} for expired/invalid,
    // but consumeUnsubscribeToken must NEVER throw for the expired/invalid case
    // (parity with the SQLite impl + the conformance contract). Even if a leaf
    // version signalled expired via HTTP 410, the client maps it back to the
    // success-shaped result rather than throwing.
    // A hypothetical leaf signalling expired via HTTP 410 would use the standard
    // error envelope {success:false,error}; doLeafFetch lifts `error` into the
    // NewsletterServiceError message, from which we recover the reason.
    resetStub({ firstStatus: 410, body: { success: false, error: 'token expired' } })
    const client = new ServiceNewsletterClient()
    const result = await withTenant(() => client.consumeUnsubscribeToken('expired-tok'))
    expect(result).toEqual({ ok: false, reason: 'expired' })
  })

  it('maps a 404 from consumeUnsubscribeToken to {ok:false,reason:invalid} (F-LOW)', async () => {
    resetStub({ firstStatus: 404, body: { success: false, error: 'unknown token' } })
    const client = new ServiceNewsletterClient()
    const result = await withTenant(() => client.consumeUnsubscribeToken('gone-tok'))
    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })

  it('still propagates a 5xx from consumeUnsubscribeToken as NewsletterServiceError', async () => {
    resetStub({ firstStatus: 500, body: { success: false, error: 'boom' } })
    const client = new ServiceNewsletterClient()
    await expect(
      withTenant(() => client.consumeUnsubscribeToken('any-tok'))
    ).rejects.toSatisfy((e: unknown) => e instanceof NewsletterServiceError && e.status === 500)
  })

  it('throws NewsletterServiceError with status 503 when leaf returns 503 on both attempts', async () => {
    resetStub({ firstStatus: 503, subsequentStatus: 503, body: { error: 'Service unavailable' } })
    const client = new ServiceNewsletterClient()
    // GET with two 503s → retries once, still fails
    await expect(withTenant(() => client.listNewsletters())).rejects.toSatisfy(
      (e: unknown) => e instanceof NewsletterServiceError && e.status === 503
    )
  })

  it('throws an error when NEWSLETTER_SERVICE_URL is not set', async () => {
    delete process.env.NEWSLETTER_SERVICE_URL
    const client = new ServiceNewsletterClient()
    await expect(withTenant(() => client.listNewsletters())).rejects.toThrow(/NEWSLETTER_SERVICE_URL/)
    process.env.NEWSLETTER_SERVICE_URL = `http://127.0.0.1:${port}`
  })

  it('throws an error when INTERNAL_NEWSLETTER_SECRET is not set', async () => {
    delete process.env.INTERNAL_NEWSLETTER_SECRET
    const client = new ServiceNewsletterClient()
    await expect(withTenant(() => client.listNewsletters())).rejects.toThrow(/INTERNAL_NEWSLETTER_SECRET/)
    process.env.INTERNAL_NEWSLETTER_SECRET = 'test-secret-1234'
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Retry policy
// ═══════════════════════════════════════════════════════════════════════════════

describe('ServiceNewsletterClient — retry policy', () => {
  it('retries once on GET when leaf returns 503 first time then 200', async () => {
    resetStub({
      firstStatus: 503,
      subsequentStatus: 200,
      body: { success: true, data: [] },
    })
    const client = new ServiceNewsletterClient()
    // Should succeed on second attempt
    const result = await withTenant(() => client.listNewsletters())
    expect(result).toEqual([])
    expect(stubBehaviour.callCount).toBe(2)
  })

  it('does NOT retry on POST even when leaf returns 503', async () => {
    resetStub({
      firstStatus: 503,
      subsequentStatus: 200,
      body: { success: true, data: { id: 1, title: 'T', status: 'draft' } },
    })
    const client = new ServiceNewsletterClient()
    await expect(
      withTenant(() =>
        client.createNewsletter({
          title: 'T',
          odt_path: '/t.odt',
          subject: 'S',
          created_by: 'u1',
        })
      )
    ).rejects.toSatisfy((e: unknown) => e instanceof NewsletterServiceError && e.status === 503)
    // Only one call — no retry
    expect(stubBehaviour.callCount).toBe(1)
  })

  it('does NOT retry on DELETE even when leaf returns 503', async () => {
    resetStub({ firstStatus: 503, subsequentStatus: 200 })
    const client = new ServiceNewsletterClient()
    await expect(withTenant(() => client.deleteMailingList(1))).rejects.toSatisfy(
      (e: unknown) => e instanceof NewsletterServiceError && e.status === 503
    )
    expect(stubBehaviour.callCount).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Not-supported methods (no leaf endpoint)
// ═══════════════════════════════════════════════════════════════════════════════

describe('ServiceNewsletterClient — not-supported methods', () => {
  it('getScheduledDueNewsletters throws NotSupportedViaServiceError', async () => {
    const client = new ServiceNewsletterClient()
    await expect(withTenant(() => client.getScheduledDueNewsletters())).rejects.toBeInstanceOf(
      NotSupportedViaServiceError
    )
  })

  it('claimNewsletterForSending throws NotSupportedViaServiceError', async () => {
    const client = new ServiceNewsletterClient()
    await expect(withTenant(() => client.claimNewsletterForSending(1))).rejects.toBeInstanceOf(
      NotSupportedViaServiceError
    )
  })

  it('claimRecipient throws NotSupportedViaServiceError', async () => {
    const client = new ServiceNewsletterClient()
    await expect(withTenant(() => client.claimRecipient(1, 'a@b.de'))).rejects.toBeInstanceOf(
      NotSupportedViaServiceError
    )
  })

  it('markSent throws NotSupportedViaServiceError', async () => {
    const client = new ServiceNewsletterClient()
    await expect(withTenant(() => client.markSent(1, 'a@b.de', '<id>'))).rejects.toBeInstanceOf(
      NotSupportedViaServiceError
    )
  })

  it('releaseDeliveryClaim throws NotSupportedViaServiceError', async () => {
    const client = new ServiceNewsletterClient()
    await expect(withTenant(() => client.releaseDeliveryClaim(1, 'a@b.de'))).rejects.toBeInstanceOf(
      NotSupportedViaServiceError
    )
  })

  it('addSendToken throws NotSupportedViaServiceError', async () => {
    const client = new ServiceNewsletterClient()
    await expect(withTenant(() => client.addSendToken('tok', 1, 'a@b.de'))).rejects.toBeInstanceOf(
      NotSupportedViaServiceError
    )
  })

  it('addUnsubscribe throws NotSupportedViaServiceError', async () => {
    const client = new ServiceNewsletterClient()
    await expect(withTenant(() => client.addUnsubscribe('a@b.de', 'tok'))).rejects.toBeInstanceOf(
      NotSupportedViaServiceError
    )
  })

  it('isUnsubscribed throws NotSupportedViaServiceError', async () => {
    const client = new ServiceNewsletterClient()
    await expect(withTenant(() => client.isUnsubscribed('a@b.de'))).rejects.toBeInstanceOf(
      NotSupportedViaServiceError
    )
  })

  it('purgeSendTokensOlderThan90Days throws NotSupportedViaServiceError', async () => {
    const client = new ServiceNewsletterClient()
    await expect(withTenant(() => client.purgeSendTokensOlderThan90Days())).rejects.toBeInstanceOf(
      NotSupportedViaServiceError
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Method routing — verifies correct HTTP verbs and path shapes
// ═══════════════════════════════════════════════════════════════════════════════

describe('ServiceNewsletterClient — method routing', () => {
  it('listNewsletters → GET /api/v1/newsletters', async () => {
    resetStub({ body: { success: true, data: [] } })
    const client = new ServiceNewsletterClient()
    await withTenant(() => client.listNewsletters())
    expect(lastRequest!.method).toBe('GET')
    expect(lastRequest!.url).toBe('/api/v1/newsletters')
  })

  it('createMailingList → POST /api/v1/lists', async () => {
    resetStub({ firstStatus: 201, body: { success: true, data: { id: 1, name: 'L' } } })
    const client = new ServiceNewsletterClient()
    await withTenant(() => client.createMailingList('L'))
    expect(lastRequest!.method).toBe('POST')
    expect(lastRequest!.url).toBe('/api/v1/lists')
    expect((lastRequest!.body as Record<string, unknown>).name).toBe('L')
  })

  it('listMailingLists → GET /api/v1/lists', async () => {
    resetStub({ body: { success: true, data: [] } })
    const client = new ServiceNewsletterClient()
    await withTenant(() => client.listMailingLists())
    expect(lastRequest!.method).toBe('GET')
    expect(lastRequest!.url).toBe('/api/v1/lists')
  })

  it('deleteMailingList → DELETE /api/v1/lists/42', async () => {
    resetStub({ body: { success: true } })
    const client = new ServiceNewsletterClient()
    await withTenant(() => client.deleteMailingList(42))
    expect(lastRequest!.method).toBe('DELETE')
    expect(lastRequest!.url).toBe('/api/v1/lists/42')
  })

  it('deleteMember → DELETE /api/v1/lists/:listId/members/:memberId (F-IMP: real listId, no placeholder 0)', async () => {
    resetStub({ body: { success: true } })
    const client = new ServiceNewsletterClient()
    await withTenant(() => client.deleteMember(7, 99))
    expect(lastRequest!.method).toBe('DELETE')
    expect(lastRequest!.url).toBe('/api/v1/lists/7/members/99')
    // The placeholder `lists/0/...` URL must be gone.
    expect(lastRequest!.url).not.toContain('/lists/0/')
  })

  it('getNewsletter → GET /api/v1/newsletters/7', async () => {
    resetStub({ body: { success: true, data: { id: 7, title: 'T', status: 'draft' } } })
    const client = new ServiceNewsletterClient()
    const result = await withTenant(() => client.getNewsletter(7))
    expect(lastRequest!.method).toBe('GET')
    expect(lastRequest!.url).toBe('/api/v1/newsletters/7')
    expect(result).not.toBeNull()
    expect((result as { id: number }).id).toBe(7)
  })

  it('getNewsletter returns null when leaf returns 404', async () => {
    resetStub({ firstStatus: 404, body: { success: false, error: 'Not found' } })
    const client = new ServiceNewsletterClient()
    const result = await withTenant(() => client.getNewsletter(9999))
    expect(result).toBeNull()
  })

  it('dispatchNow → POST /api/v1/newsletters/3/send', async () => {
    resetStub({ firstStatus: 202, body: { success: true, data: { newsletterId: 3, status: 'sending' } } })
    const client = new ServiceNewsletterClient()
    await withTenant(() => client.dispatchNow(3, 'actor-sub', async () => []))
    expect(lastRequest!.method).toBe('POST')
    expect(lastRequest!.url).toBe('/api/v1/newsletters/3/send')
  })

  it('consumeUnsubscribeToken → POST /api/v1/unsubscribe', async () => {
    resetStub({ body: { ok: true } })
    const client = new ServiceNewsletterClient()
    const result = await withTenant(() => client.consumeUnsubscribeToken('my-token'))
    expect(lastRequest!.method).toBe('POST')
    expect(lastRequest!.url).toBe('/api/v1/unsubscribe')
    expect((lastRequest!.body as Record<string, unknown>).token).toBe('my-token')
    expect(result).toEqual({ ok: true })
  })

  it('updateNewsletter with status=scheduled → POST /api/v1/newsletters/:id/schedule', async () => {
    resetStub({ body: { success: true, data: { id: 5, status: 'scheduled' } } })
    const client = new ServiceNewsletterClient()
    await withTenant(() =>
      client.updateNewsletter(5, { status: 'scheduled', scheduled_at: '2026-07-01 12:00:00' })
    )
    expect(lastRequest!.method).toBe('POST')
    expect(lastRequest!.url).toBe('/api/v1/newsletters/5/schedule')
  })

  it('updateNewsletter without status → PATCH /api/v1/newsletters/:id', async () => {
    resetStub({ body: { success: true, data: { id: 5, subject: 'New' } } })
    const client = new ServiceNewsletterClient()
    await withTenant(() => client.updateNewsletter(5, { subject: 'New' }))
    expect(lastRequest!.method).toBe('PATCH')
    expect(lastRequest!.url).toBe('/api/v1/newsletters/5')
    expect((lastRequest!.body as Record<string, unknown>).subject).toBe('New')
  })

  it('countNewsletterRecipients → GET /api/v1/newsletters/:id/recipients → .length', async () => {
    resetStub({
      body: {
        success: true,
        data: [
          { id: 1, newsletter_id: 2 },
          { id: 2, newsletter_id: 2 },
          { id: 3, newsletter_id: 2 },
        ],
      },
    })
    const client = new ServiceNewsletterClient()
    const count = await withTenant(() => client.countNewsletterRecipients(2))
    expect(count).toBe(3)
    expect(lastRequest!.url).toBe('/api/v1/newsletters/2/recipients')
  })

  it('recordNewsletterAudit → POST /api/v1/newsletters/:id/audit', async () => {
    resetStub({ body: { success: true } })
    const client = new ServiceNewsletterClient()
    await withTenant(() => client.recordNewsletterAudit(10, 'user-sub', 'send-now'))
    expect(lastRequest!.method).toBe('POST')
    expect(lastRequest!.url).toBe('/api/v1/newsletters/10/audit')
  })

  it('countSubscribers → GET /api/v1/stats', async () => {
    resetStub({ body: { success: true, data: { subscribers: 42, newsletters: 5 } } })
    const client = new ServiceNewsletterClient()
    const count = await withTenant(() => client.countSubscribers())
    expect(count).toBe(42)
    expect(lastRequest!.url).toBe('/api/v1/stats')
  })
})
