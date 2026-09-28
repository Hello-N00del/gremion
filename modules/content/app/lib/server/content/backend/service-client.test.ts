// service-client.test.ts — Task 3: ServiceContentClient HTTP ACL
// Tests: kind discriminant, header forwarding, 404→null, retry-on-GET-503, no-retry-POST-500

import { describe, it, expect, vi, beforeEach } from 'vitest'

// getTenant() is fail-closed (throws when no AsyncLocalStorage context is active).
// Mock it so buildHeaders() can emit x-tenant-id / x-tenant-slug without a live request.
vi.mock('$lib/server/tenant/context', () => ({
  getTenant: () => ({ id: 'tenant-1', slug: 'default' }),
}))

import { ServiceContentClient, ContentServiceError } from './service-client'
import { ChannelNotPublishableError } from '../publish-errors'

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

  it('publish propagates a non-409 leaf error (e.g. 500) as ContentServiceError', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }))
    const c = new ServiceContentClient()
    ;(c as any).fetchImpl = fetchImpl
    await expect(c.publish('post-7', 'email')).rejects.toBeInstanceOf(ContentServiceError)
  })
})
