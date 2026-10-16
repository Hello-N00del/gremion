// service-client.test.ts — Task 3: ServiceContentClient HTTP ACL
// Tests: kind discriminant, header forwarding, 404→null, retry-on-GET-503, no-retry-POST-500

import { describe, it, expect, vi, beforeEach } from 'vitest'

// getTenant() is fail-closed (throws when no AsyncLocalStorage context is active).
// Mock it so buildHeaders() can emit x-tenant-id / x-tenant-slug without a live request.
vi.mock('$lib/server/tenant/context', () => ({
  getTenant: () => ({ id: 'tenant-1', slug: 'default' }),
}))

import { ServiceContentClient, ContentServiceError } from './service-client'
import { ChannelNotPublishableError, TenantIdentityMismatchError } from '../publish-errors'

beforeEach(() => {
  process.env.CONTENT_SERVICE_URL = 'http://content-service:8080'
  process.env.INTERNAL_CONTENT_SECRET = 's3cr3t'
})

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('ServiceContentClient', () => {
  it('kind is service', () => {
    expect(new ServiceContentClient().kind).toBe('service')
  })

  it('forwards x-internal-auth, correlation, and tenant headers on createPost', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({
        id: 'p1',
        slug: 'p1',
        title: 'T',
        body_html: '',
        created_by: 'u',
        created_at: 'x',
        updated_at: 'x',
      }),
    )
    const c = new ServiceContentClient({ correlationId: 'corr-1' })
    ;(c as any).fetchImpl = fetchImpl
    await c.createPost({ title: 'T', created_by: 'u' })
    const [url, init] = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit]) ?? []
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(url).toBe('http://content-service:8080/api/v1/posts')
    expect(init.method).toBe('POST')
    expect(headers['x-internal-auth']).toBe('s3cr3t')
    expect(headers['x-correlation-id']).toBe('corr-1')
    // Tenant headers forwarded from the mocked getTenant() → { id: 'tenant-1', slug: 'default' }
    expect(headers['x-tenant-id']).toBe('tenant-1')
    expect(headers['x-tenant-slug']).toBe('default')
  })

  it('maps 404 to null on getPost', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }))
    const c = new ServiceContentClient()
    ;(c as any).fetchImpl = fetchImpl
    expect(await c.getPost('missing')).toBeNull()
  })

  it('retries once on a 503 for an idempotent GET, then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(jsonRes([]))
    const c = new ServiceContentClient()
    ;(c as any).fetchImpl = fetchImpl
    expect(await c.listPosts()).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a POST and throws ContentServiceError on 500', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }))
    const c = new ServiceContentClient()
    ;(c as any).fetchImpl = fetchImpl
    await expect(c.createPost({ title: 'T', created_by: 'u' })).rejects.toBeInstanceOf(
      ContentServiceError,
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('consumeUnsubscribeToken: 410 Gone → { ok: false, reason: "expired" }', async () => {
    const fetchImpl = vi.fn(async () => new Response('token expired', { status: 410 }))
    const c = new ServiceContentClient()
    ;(c as any).fetchImpl = fetchImpl
    const result = await c.consumeUnsubscribeToken('tok-expired')
    expect(result).toEqual({ ok: false, reason: 'expired' })
  })

  it('consumeUnsubscribeToken: 404 Not Found → { ok: false, reason: "invalid" }', async () => {
    const fetchImpl = vi.fn(async () => new Response('token not found', { status: 404 }))
    const c = new ServiceContentClient()
    ;(c as any).fetchImpl = fetchImpl
    const result = await c.consumeUnsubscribeToken('tok-invalid')
    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })

  it('enqueuePublishOp sends action:"enqueue" in POST body', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const c = new ServiceContentClient()
    ;(c as any).fetchImpl = fetchImpl
    await c.enqueuePublishOp('post-1', 'instagram', 'publish')
    const [, init] = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit]) ?? []
    const body = JSON.parse((init?.body ?? '') as string)
    expect(body.action).toBe('enqueue')
    expect(body.post_id).toBe('post-1')
    expect(body.channel).toBe('instagram')
    expect(body.op).toBe('publish')
  })

  // ── delivery claim token (R29-LOW-07 L1) ────────────────────────────────────

  it('claimDelivery returns the result and the claim token from the leaf', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ result: 'fresh', claim_token: '1790000000123456' }))
    const c = new ServiceContentClient()
    ;(c as any).fetchImpl = fetchImpl
    expect(await c.claimDelivery('p1', 'a@b.de')).toEqual({
      result: 'fresh',
      claimToken: '1790000000123456',
    })
    const [url] = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit]) ?? []
    expect(url).toBe('http://content-service:8080/api/v1/deliveries/claim')
  })

  it('claimDelivery maps a non-fresh result to a null token', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ result: 'in-flight', claim_token: null }))
    const c = new ServiceContentClient()
    ;(c as any).fetchImpl = fetchImpl
    expect(await c.claimDelivery('p1', 'a@b.de')).toEqual({ result: 'in-flight', claimToken: null })
  })

  it('claimDelivery still accepts a legacy leaf that answers a bare string (no token)', async () => {
    const fetchImpl = vi.fn(async () => jsonRes('fresh'))
    const c = new ServiceContentClient()
    ;(c as any).fetchImpl = fetchImpl
    expect(await c.claimDelivery('p1', 'a@b.de')).toEqual({ result: 'fresh', claimToken: null })
  })

  it('markDeliveryFailed sends claim_token only when a token is given', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const c = new ServiceContentClient()
    ;(c as any).fetchImpl = fetchImpl
    await c.markDeliveryFailed('p1', 'a@b.de', 'boom', '1790000000123456')
    await c.markDeliveryFailed('p1', 'a@b.de', 'boom')
    const bodies = fetchImpl.mock.calls.map(
      (call) => JSON.parse(((call as unknown as [string, RequestInit])[1].body ?? '') as string),
    )
    expect(bodies[0]).toEqual({ error: 'boom', claim_token: '1790000000123456' })
    expect(bodies[1]).toEqual({ error: 'boom' })
  })

  // ── per-channel publish delegation ──────────────────────────────────────────

  it('publish POSTs the per-channel leaf endpoint and returns the PublishResult', async () => {
    const result = { channel: 'portal', status: 'published', externalRef: '42', warnings: [] }
    const fetchImpl = vi.fn(async () => jsonRes(result))
    const c = new ServiceContentClient({ correlationId: 'corr-9' })
    ;(c as any).fetchImpl = fetchImpl
    const out = await c.publish('post-7', 'portal')
    expect(out).toEqual(result)
    const [url, init] = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit]) ?? []
    expect(url).toBe('http://content-service:8080/api/v1/posts/post-7/publish/portal')
    expect(init.method).toBe('POST')
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(headers['x-correlation-id']).toBe('corr-9')
  })

  it('publish returns an email "failed" 200 body (SMTP-unconfigured) rather than throwing', async () => {
    const failed = { channel: 'email', status: 'failed', recipientCount: 0, warnings: [], detail: 'SMTP not configured' }
    const fetchImpl = vi.fn(async () => jsonRes(failed))
    const c = new ServiceContentClient()
    ;(c as any).fetchImpl = fetchImpl
    await expect(c.publish('post-7', 'email')).resolves.toMatchObject({ status: 'failed', detail: 'SMTP not configured' })
  })

  it('publish maps a leaf 409 to ChannelNotPublishableError (disabled/missing channel)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({ success: false, error: 'channel is disabled' }, 409),
    )
    const c = new ServiceContentClient()
    ;(c as any).fetchImpl = fetchImpl
    await expect(c.publish('post-7', 'email')).rejects.toBeInstanceOf(ChannelNotPublishableError)
    // POST is not retried.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('publish surfaces a leaf 409 tenant_identity_mismatch as TenantIdentityMismatchError, not ChannelNotPublishableError', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({ success: false, error: 'tenant_identity_mismatch' }, 409),
    )
    const c = new ServiceContentClient()
    ;(c as any).fetchImpl = fetchImpl
    const err = await c.publish('post-7', 'email').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TenantIdentityMismatchError)
    expect(err).not.toBeInstanceOf(ChannelNotPublishableError)
    expect((err as Error).message).toMatch(/Mandantenzuordnung/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('publish propagates a non-409 leaf error (e.g. 500) as ContentServiceError', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }))
    const c = new ServiceContentClient()
    ;(c as any).fetchImpl = fetchImpl
    await expect(c.publish('post-7', 'email')).rejects.toBeInstanceOf(ContentServiceError)
  })

  // ── F1-FIX-07 H08 (K5#27): route ids never steer the leaf path ──────────────

  it('encodes a traversal id into ONE path segment (never reaches /api/v1/lists)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }))
    const c = new ServiceContentClient()
    ;(c as any).fetchImpl = fetchImpl
    await c.getPost('x/../../lists')
    const [url] = (fetchImpl.mock.calls[0] as unknown as [string]) ?? []
    expect(url).toBe('http://content-service:8080/api/v1/posts/x%2F..%2F..%2Flists')
    expect(new URL(url).pathname).toBe('/api/v1/posts/x%2F..%2F..%2Flists')
  })

  it.each(['..', '.', ''])('refuses the dot/empty segment %j without any leaf request', async (id) => {
    const fetchImpl = vi.fn(async () => jsonRes([]))
    const c = new ServiceContentClient()
    ;(c as any).fetchImpl = fetchImpl
    await expect(c.listMembers(id)).rejects.toMatchObject({ status: 400 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('encodes every path param (list + member ids, channel)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const c = new ServiceContentClient()
    ;(c as any).fetchImpl = fetchImpl
    await c.removeListMember('l/1', 'm?2')
    await c.clearPublication('p#1', 'portal')
    const urls = fetchImpl.mock.calls.map((call) => (call as unknown as [string])[0])
    expect(urls).toEqual([
      'http://content-service:8080/api/v1/lists/l%2F1/members/m%3F2',
      'http://content-service:8080/api/v1/publications/p%231/portal',
    ])
  })

  // ── K5#1: the synchronous publish gets its own budget; bodies are bounded ───

  function hangingFetch() {
    return vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          )
        }),
    )
  }

  it('publish is NOT aborted at the 5 s CRUD budget, but is at its own budget', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = hangingFetch()
      const c = new ServiceContentClient()
      ;(c as any).fetchImpl = fetchImpl
      let settled: unknown = 'pending'
      const p = c.publish('post-7', 'email').then(
        () => 'resolved',
        (e: unknown) => e,
      )
      void p.then((v) => {
        settled = v
      })
      await vi.advanceTimersByTimeAsync(6_000)
      expect(settled).toBe('pending')
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(settled).toMatchObject({ name: 'AbortError' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a response body that never finishes is aborted at the request budget', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('[{"id":'))
            init.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('The operation was aborted.', 'AbortError')),
            )
          },
        })
        return new Response(body, { status: 200 })
      })
      const c = new ServiceContentClient()
      ;(c as any).fetchImpl = fetchImpl
      let settled: unknown = 'pending'
      void c.createPost({ title: 'T', created_by: 'u' }).then(
        () => {
          settled = 'resolved'
        },
        (e: unknown) => {
          settled = e
        },
      )
      await vi.advanceTimersByTimeAsync(6_000)
      expect(settled).toMatchObject({ name: 'AbortError' })
    } finally {
      vi.useRealTimers()
    }
  })
})
