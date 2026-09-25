/**
 * Unit tests for the content kernel callback client (Task 17).
 *
 * Dependency-free: a FAKE fetch records the request URL/headers/body and returns
 * canned responses. Asserts that EVERY request forwards the internal secret +
 * tenant headers + correlation id (the kernel guard rejects requests missing
 * any of them).
 *
 * Extended beyond the newsletter version to cover the content-specific
 * `portalPublish` method (POST /api/internal/content/portal-publish).
 */
import { describe, it, expect } from 'vitest'
import { createKernelClient, MailUnconfiguredError, type FetchLike } from '../src/kernel-client.ts'
import type { TenantRef } from '../src/tenant-store.ts'
import { PORTAL_PUBLISH_CONTRACT } from '@gremion/ports/content-portal-contract'

const TENANT: TenantRef = { id: 'tid-1', slug: 'alpha' }

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function makeFetch(
  respond: (url: string) => { ok: boolean; status: number; body: unknown },
): { fetchImpl: FetchLike; calls: Captured[] } {
  const calls: Captured[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    const r = respond(url)
    return {
      ok: r.ok,
      status: r.status,
      async text() { return typeof r.body === 'string' ? r.body : JSON.stringify(r.body) },
      async json() { return r.body },
    }
  }
  return { fetchImpl, calls }
}

/**
 * A fake fetch that returns a DIFFERENT response per call — used to drive the
 * bounded-retry path. An element with `{ throwNetwork: true }` makes that attempt
 * reject like a transport/network failure (TypeError) instead of returning a
 * Response. Once the sequence is exhausted the LAST element is reused.
 */
type SeqResponse =
  | { ok: boolean; status: number; body: unknown }
  | { throwNetwork: true }

function makeSequencedFetch(
  responses: SeqResponse[],
): { fetchImpl: FetchLike; calls: Captured[] } {
  const calls: Captured[] = []
  let i = 0
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    const r = responses[Math.min(i, responses.length - 1)]!
    i++
    if ('throwNetwork' in r) throw new TypeError('simulated network failure')
    return {
      ok: r.ok,
      status: r.status,
      async text() { return typeof r.body === 'string' ? r.body : JSON.stringify(r.body) },
      async json() { return r.body },
    }
  }
  return { fetchImpl, calls }
}

describe('createKernelClient — header forwarding', () => {
  it('forwards secret + tenant headers + correlation id on resolveGroup', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      ok: true, status: 200,
      body: { members: [
        { email: 'a@x.com', name: 'A' },
        { email: 'b@x.com' },         // missing name → null
        { name: 'no-email' },         // dropped (no email)
        { email: '' },                // dropped (empty email)
      ] },
    }))
    const client = createKernelClient({
      baseUrl: 'http://kernel.internal',
      secret: 's', tenant: TENANT, correlationId: '7', fetchImpl,
    })
    const members = await client.resolveGroup('grp-9')
    expect(members).toEqual([
      { email: 'a@x.com', name: 'A' },
      { email: 'b@x.com', name: null },
    ])
    const c = calls[0]!
    expect(c.url).toBe('http://kernel.internal/api/internal/newsletter/resolve-group')
    expect(c.headers['x-internal-auth']).toBe('s')
    expect(c.headers['x-correlation-id']).toBe('7')
    expect(JSON.parse(c.body!)).toEqual({ groupId: 'grp-9' })
    // No proxy-trust config → NEITHER proxy-trust header (dev path / byte-identical no-op).
    expect(c.headers['x-proxy-trust']).toBeUndefined()
    expect(c.headers['x-forwarded-host']).toBeUndefined()
  })

  it('throws on a non-ok resolveGroup response', async () => {
    const { fetchImpl } = makeFetch(() => ({ ok: false, status: 502, body: 'bad gateway' }))
    const client = createKernelClient({
      baseUrl: 'http://k', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    await expect(client.resolveGroup('grp-1')).rejects.toThrow(/502/)
  })
})

// ── sendMail (SP-3 INTEGRATION-DELTA §1 Option B2 — kernel mail seam) ──────────
describe('createKernelClient — sendMail (kernel mail seam)', () => {
  it('forwards secret + tenant headers + correlation id, posts {to,subject,html} WITHOUT a from, and returns messageId', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      ok: true, status: 200, body: { messageId: '<abc@kernel>' },
    }))
    const client = createKernelClient({
      baseUrl: 'http://kernel.internal/',
      secret: 's3cr3t', tenant: TENANT, correlationId: '99', fetchImpl,
    })
    const res = await client.sendMail({ to: 'r@x.com', subject: 'Hi', html: '<p>body</p>' })
    expect(res).toEqual({ messageId: '<abc@kernel>' })

    expect(calls).toHaveLength(1)
    const c = calls[0]!
    expect(c.url).toBe('http://kernel.internal/api/internal/newsletter/send-mail')
    expect(c.method).toBe('POST')
    // the SAME guard headers as resolveGroup
    expect(c.headers['x-internal-auth']).toBe('s3cr3t')
    expect(c.headers['x-tenant-id']).toBe('tid-1')
    expect(c.headers['x-tenant-slug']).toBe('alpha')
    expect(c.headers['x-correlation-id']).toBe('99')
    // Option B2: the kernel resolves per-tenant from-fields — the leaf sends NO from.
    const sent = JSON.parse(c.body!)
    expect(sent).toEqual({ to: 'r@x.com', subject: 'Hi', html: '<p>body</p>' })
    expect(sent).not.toHaveProperty('from')
    expect(sent).not.toHaveProperty('from_address')
    expect(sent).not.toHaveProperty('from_name')
  })

  it('tolerates a 200 with no messageId (returns empty string, not a throw)', async () => {
    const { fetchImpl } = makeFetch(() => ({ ok: true, status: 200, body: {} }))
    const client = createKernelClient({
      baseUrl: 'http://k', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    await expect(
      client.sendMail({ to: 'r@x.com', subject: 'S', html: 'h' }),
    ).resolves.toEqual({ messageId: '' })
  })

  it('maps a 503 smtp-unconfigured to MailUnconfiguredError (a SEND FAILURE, not a generic throw)', async () => {
    const { fetchImpl } = makeFetch(() => ({
      ok: false, status: 503, body: { success: false, error: 'smtp-unconfigured' },
    }))
    const client = createKernelClient({
      baseUrl: 'http://k', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    await expect(
      client.sendMail({ to: 'r@x.com', subject: 'S', html: 'h' }),
    ).rejects.toBeInstanceOf(MailUnconfiguredError)
  })

  it('throws a generic (retryable) Error on a non-503 non-ok status', async () => {
    const { fetchImpl } = makeFetch(() => ({ ok: false, status: 502, body: 'bad gateway' }))
    const client = createKernelClient({
      baseUrl: 'http://k', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    const p = client.sendMail({ to: 'r@x.com', subject: 'S', html: 'h' })
    await expect(p).rejects.toThrow(/502/)
    await expect(p).rejects.not.toBeInstanceOf(MailUnconfiguredError)
  })

  it('a 503 WITHOUT the smtp-unconfigured body is a generic (retryable) Error, not MailUnconfiguredError', async () => {
    const { fetchImpl } = makeFetch(() => ({ ok: false, status: 503, body: { error: 'overloaded' } }))
    const client = createKernelClient({
      baseUrl: 'http://k', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    await expect(
      client.sendMail({ to: 'r@x.com', subject: 'S', html: 'h' }),
    ).rejects.not.toBeInstanceOf(MailUnconfiguredError)
  })
})

// ── portalPublish (content-specific) ─────────────────────────────────────────
describe('createKernelClient — portalPublish (content portal callback)', () => {
  it('POSTs to /api/internal/content/portal-publish with all five context headers and returns news_posts_id', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      ok: true, status: 200,
      body: { id: 42, slug: 'my-post', published_at: '2026-07-01T10:00:00.000Z', content_origin_post_id: 'post-uuid-1' },
    }))
    const client = createKernelClient({
      baseUrl: 'http://kernel.internal/',
      secret: 's3cr3t', tenant: TENANT, correlationId: '77', fetchImpl,
    })
    const result = await client.portalPublish('post-uuid-1', 'My Title', '<p>body</p>')
    expect(result).toEqual({ news_posts_id: '42' })

    expect(calls).toHaveLength(1)
    const c = calls[0]!
    expect(c.url).toBe('http://kernel.internal/api/internal/content/portal-publish')
    expect(c.method).toBe('POST')
    // all five context headers must be forwarded
    expect(c.headers['x-internal-auth']).toBe('s3cr3t')
    expect(c.headers['x-tenant-id']).toBe('tid-1')
    expect(c.headers['x-tenant-slug']).toBe('alpha')
    expect(c.headers['x-correlation-id']).toBe('77')
    expect(c.headers['content-type']).toBe('application/json')
    const body = JSON.parse(c.body!)
    expect(body).toEqual({ contentPostId: 'post-uuid-1', title: 'My Title', bodyHtml: '<p>body</p>' })
  })

  it('includes externalRef in body when provided', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      ok: true, status: 200,
      body: { id: 99, slug: 'updated', published_at: '2026-07-01T12:00:00.000Z', content_origin_post_id: 'post-uuid-2' },
    }))
    const client = createKernelClient({
      baseUrl: 'http://kernel.internal',
      secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    const result = await client.portalPublish('post-uuid-2', 'Title 2', '<p>updated</p>', 'ext-ref-123')
    expect(result).toEqual({ news_posts_id: '99' })
    const body = JSON.parse(calls[0]!.body!)
    expect(body).toEqual({ contentPostId: 'post-uuid-2', title: 'Title 2', bodyHtml: '<p>updated</p>', externalRef: 'ext-ref-123' })
  })

  it('a re-call with the same contentPostId returns the same news_posts_id (idempotent via unique constraint)', async () => {
    // The kernel endpoint is idempotent: same contentPostId → same row (SELECT + UPDATE path).
    // The client just maps kernel id → news_posts_id; idempotency is kernel-side.
    const RESPONSE = { id: 55, slug: 'idempotent-post', published_at: '2026-07-01T00:00:00.000Z', content_origin_post_id: 'same-uuid' }
    const { fetchImpl } = makeFetch(() => ({ ok: true, status: 200, body: RESPONSE }))
    const client = createKernelClient({
      baseUrl: 'http://k', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    const r1 = await client.portalPublish('same-uuid', 'T', '<p>b</p>')
    const r2 = await client.portalPublish('same-uuid', 'T', '<p>b</p>')
    expect(r1).toEqual({ news_posts_id: '55' })
    expect(r2).toEqual({ news_posts_id: '55' })
    expect(r1).toEqual(r2)
  })

  it('throws a generic Error on a non-ok portalPublish response', async () => {
    const { fetchImpl } = makeFetch(() => ({ ok: false, status: 500, body: 'internal error' }))
    const client = createKernelClient({
      baseUrl: 'http://k', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    await expect(
      client.portalPublish('post-uuid-err', 'T', '<p>b</p>'),
    ).rejects.toThrow(/500/)
  })

  it('sends no proxy-trust and no forwarded host on portalPublish (HARDENING-3)', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      ok: true, status: 200,
      body: { id: 1, slug: 's', published_at: '2026-07-01T00:00:00.000Z', content_origin_post_id: 'p' },
    }))
    const client = createKernelClient({
      baseUrl: 'http://kernel.internal', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    await client.portalPublish('p', 'T', '<p>b</p>')
    const c = calls[0]!
    expect(c.headers['x-proxy-trust']).toBeUndefined()
    expect(c.headers['x-forwarded-host']).toBeUndefined()
    // portalPublish WRITES into the kernel's data plane, so which tenant the
    // kernel resolves is the whole safety question. It is the id below.
    expect(c.headers['x-tenant-id']).toBe(TENANT.id)
  })
})

// ── the callback header set is CLOSED (Tenancy D1 HARDENING-3) ───────────────
// A kernel callback carries identity and a secret, and nothing else. It used to
// have to carry a hostname too, because the kernel selected the tenant by
// looking `x-forwarded-host` up in `tenant_domain` — first a synthesised
// `<slug>.<apex>` (a cross-tenant selector once a tenant brought its own
// domain), then the tenant's REGISTERED host threaded down from the kernel and
// cached in `tenant_catalog.primary_host` (a replica the scheduler could not
// backfill). The kernel now selects from `x-tenant-id`, so there is no host.
//
// These tests assert the header set EXHAUSTIVELY rather than checking a few
// keys: that is what makes "no host, ever" a property this file can hold.
const CALLBACK_HEADERS = [
  'content-type',
  'x-internal-auth',
  'x-tenant-id',
  'x-tenant-slug',
  'x-correlation-id',
].sort()

describe('createKernelClient — the callback header set is closed', () => {
  function client(fetchImpl: FetchLike) {
    return createKernelClient({
      baseUrl: 'http://kernel.internal', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
  }

  it('resolveGroup sends EXACTLY the five callback headers — no host, no proxy-trust', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ ok: true, status: 200, body: { members: [] } }))
    await client(fetchImpl).resolveGroup('grp-1')
    expect(Object.keys(calls[0]!.headers).sort()).toEqual(CALLBACK_HEADERS)
  })

  it('sendMail sends EXACTLY the five callback headers', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ ok: true, status: 200, body: { messageId: '<m@k>' } }))
    await client(fetchImpl).sendMail({ to: 'r@x.com', subject: 'S', html: 'h' })
    expect(Object.keys(calls[0]!.headers).sort()).toEqual(CALLBACK_HEADERS)
  })

  it('portalPublish sends EXACTLY the five callback headers', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      ok: true, status: 200,
      body: { id: 1, slug: 's', published_at: '2026-07-01T00:00:00.000Z', content_origin_post_id: 'p' },
    }))
    await client(fetchImpl).portalPublish('11111111-2222-4333-8444-555555555555', 'T', '<p>b</p>')
    expect(Object.keys(calls[0]!.headers).sort()).toEqual(CALLBACK_HEADERS)
    expect(calls[0]!.headers['x-tenant-id']).toBe(TENANT.id)
  })

  it('NO header value contains a hostname — not the tenant’s, not the apex, not <slug>.<apex>', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ ok: true, status: 200, body: { members: [] } }))
    await client(fetchImpl).resolveGroup('grp-1')
    const values = Object.values(calls[0]!.headers).join(' | ')
    for (const host of ['rat-musterstadt.de', 'example.org', `${TENANT.slug}.example.org`]) {
      expect(values).not.toContain(host)
    }
  })

  it('the options type carries no host or proxy-trust knob to set', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ ok: true, status: 200, body: { members: [] } }))
    const c = createKernelClient({
      baseUrl: 'http://kernel.internal', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
      ...({ tenantHost: 'rat-musterstadt.de', proxyTrustSecret: 'pt-secret' } as object),
    })
    await c.resolveGroup('grp-1')
    expect(Object.keys(calls[0]!.headers).sort()).toEqual(CALLBACK_HEADERS)
  })
})

describe('createKernelClient — portalPublish retry (transient resilience)', () => {
  const OK = { id: 42, slug: 'p', published_at: '2026-07-01T00:00:00.000Z', content_origin_post_id: 'post-uuid-1' }

  it('retries a 503 twice then succeeds (3 fetches, resolves to the final id)', async () => {
    const { fetchImpl, calls } = makeSequencedFetch([
      { ok: false, status: 503, body: 'unavailable' },
      { ok: false, status: 503, body: 'unavailable' },
      { ok: true, status: 200, body: OK },
    ])
    const client = createKernelClient({
      baseUrl: 'http://k', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    await expect(client.portalPublish('post-uuid-1', 'T', '<p>b</p>')).resolves.toEqual({
      news_posts_id: '42',
    })
    expect(calls).toHaveLength(3)
  })

  it('a network throw is retried then succeeds (2 fetches)', async () => {
    const { fetchImpl, calls } = makeSequencedFetch([
      { throwNetwork: true },
      { ok: true, status: 200, body: OK },
    ])
    const client = createKernelClient({
      baseUrl: 'http://k', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    await expect(client.portalPublish('post-uuid-1', 'T', '<p>b</p>')).resolves.toEqual({
      news_posts_id: '42',
    })
    expect(calls).toHaveLength(2)
  })

  it('does NOT retry a 400 — exactly 1 call, throws a terminal error', async () => {
    const { fetchImpl, calls } = makeSequencedFetch([
      { ok: false, status: 400, body: 'bad request' },
      { ok: true, status: 200, body: OK }, // never reached
    ])
    const client = createKernelClient({
      baseUrl: 'http://k', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    await expect(client.portalPublish('post-uuid-1', 'T', '<p>b</p>')).rejects.toThrow(/400/)
    expect(calls).toHaveLength(1)
  })

  it('gives up after the bounded cap when a 503 persists (throws, does not loop forever)', async () => {
    const { fetchImpl, calls } = makeSequencedFetch([{ ok: false, status: 503, body: 'unavailable' }])
    const client = createKernelClient({
      baseUrl: 'http://k', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    await expect(client.portalPublish('post-uuid-1', 'T', '<p>b</p>')).rejects.toThrow(/503/)
    // bounded: a small finite number of attempts (initial + retries), not unbounded.
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.length).toBeLessThanOrEqual(3)
  })

  it('every attempt sends the identical contentPostId body', async () => {
    const { fetchImpl, calls } = makeSequencedFetch([
      { ok: false, status: 503, body: 'unavailable' },
      { ok: false, status: 503, body: 'unavailable' },
      { ok: true, status: 200, body: OK },
    ])
    const client = createKernelClient({
      baseUrl: 'http://k', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    await client.portalPublish('post-uuid-1', 'My Title', '<p>body</p>')
    expect(calls).toHaveLength(3)
    // all three request bodies are byte-identical (built ONCE) and carry the anchor
    const bodies = calls.map((c) => c.body)
    expect(bodies[0]).toBe(bodies[1])
    expect(bodies[1]).toBe(bodies[2])
    for (const b of bodies) {
      expect(JSON.parse(b!)).toEqual({ contentPostId: 'post-uuid-1', title: 'My Title', bodyHtml: '<p>body</p>' })
    }
  })
})

// ── two-sided contract tie (C5 leaf half) ─────────────────────────────────────
// The leaf's REAL portalPublish must serialize its POST body to EXACTLY the single
// shared @gremion/ports fixture. The kernel half (portal-publish-contract.test.ts)
// feeds the SAME fixture body into the real +server.ts POST. Envelope drift on
// EITHER side breaks its build — the fixture is the one source of truth.
describe('createKernelClient — portalPublish two-sided contract', () => {
  it('serializes portalPublish to exactly PORTAL_PUBLISH_CONTRACT.request', async () => {
    const { request } = PORTAL_PUBLISH_CONTRACT
    const { fetchImpl, calls } = makeFetch(() => ({
      ok: true, status: 200,
      body: { id: 1, slug: 's', published_at: '2026-07-01T00:00:00.000Z', content_origin_post_id: request.contentPostId },
    }))
    const client = createKernelClient({
      baseUrl: 'http://k', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    await client.portalPublish(request.contentPostId, request.title, request.bodyHtml)
    expect(JSON.parse(calls[0]!.body!)).toEqual(PORTAL_PUBLISH_CONTRACT.request)
  })
})
