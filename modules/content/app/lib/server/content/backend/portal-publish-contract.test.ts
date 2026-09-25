// gremion-ui/src/lib/server/content/backend/portal-publish-contract.test.ts
//
// WP-F C5 (kernel half) + F3 (kernel observability). This spec drives the REAL
// POST handler of the portal-publish callback route — NOT a fetch mock. Only
// `portalCallback` (the kernel-local DB transaction) is vi.mock'd, so no Postgres
// is required and this stays a unit test. It exercises:
//
//   C5  two-sided contract: feeding the SINGLE shared @gremion/ports fixture body
//       (PORTAL_PUBLISH_CONTRACT.request) into the real POST returns 200 with a
//       body whose keys are EXACTLY PORTAL_PUBLISH_CONTRACT.responseKeys. The leaf
//       half (services/content/test/kernel-client.test.ts) asserts the real
//       portalPublish serializes to that SAME fixture — so envelope drift on either
//       side fails the build.
//
//   F3  observability: a bad/absent x-internal-auth yields 401 AND a structured
//       console.warn with the correlation id and NO secret; portalCallback throwing
//       yields a stable 500 {success:false,error:'Internal error'} AND a structured
//       console.error with the correlation id; an inbound x-correlation-id is echoed
//       into the log lines.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PORTAL_PUBLISH_CONTRACT } from '@gremion/ports/content-portal-contract'

// Mock ONLY the kernel-local DB transaction — the real +server.ts POST handler,
// guard, zod validation, correlation-id + logging all run for real.
vi.mock('$lib/server/news/portal-callback', () => ({
  portalCallback: vi.fn(),
}))
import { portalCallback } from '$lib/server/news/portal-callback'
import { POST } from '../../../../routes/api/internal/content/portal-publish/+server'

const SECRET = 'contract-internal-secret-value'
const REQUEST_URL = 'http://kernel.internal/api/internal/content/portal-publish'

function req(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(REQUEST_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** A resolved PortalCallbackResult echoing the fixture's anchor. */
function okResult() {
  return {
    newsId: 42,
    slug: 'contract-fixture',
    published_at: new Date('2026-07-01T00:00:00.000Z'),
    content_origin_post_id: PORTAL_PUBLISH_CONTRACT.request.contentPostId,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.INTERNAL_CONTENT_SECRET = SECRET
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── C5: two-sided contract (kernel half) ──────────────────────────────────────
describe('portal-publish contract (kernel half) — real POST + shared fixture', () => {
  it('feeding PORTAL_PUBLISH_CONTRACT.request into the real POST returns 200 with EXACTLY responseKeys', async () => {
    vi.mocked(portalCallback).mockResolvedValueOnce(okResult())

    const res = await POST({
      request: req(PORTAL_PUBLISH_CONTRACT.request, { 'x-internal-auth': SECRET }),
    } as never)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual([...PORTAL_PUBLISH_CONTRACT.responseKeys].sort())
  })

  it('passes the fixture contentPostId straight through to portalCallback', async () => {
    vi.mocked(portalCallback).mockResolvedValueOnce(okResult())

    await POST({
      request: req(PORTAL_PUBLISH_CONTRACT.request, { 'x-internal-auth': SECRET }),
    } as never)

    expect(vi.mocked(portalCallback).mock.calls[0]![0]).toMatchObject({
      contentPostId: PORTAL_PUBLISH_CONTRACT.request.contentPostId,
      title: PORTAL_PUBLISH_CONTRACT.request.title,
      bodyHtml: PORTAL_PUBLISH_CONTRACT.request.bodyHtml,
    })
  })
})

// ── F3: kernel observability ──────────────────────────────────────────────────
describe('portal-publish observability (kernel F3)', () => {
  const CORR = '22222222-2222-2222-2222-222222222222'

  it('bad x-internal-auth → 401 + structured console.warn with correlation id and NO secret', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await POST({
      request: req(PORTAL_PUBLISH_CONTRACT.request, {
        'x-internal-auth': 'the-wrong-secret',
        'x-correlation-id': CORR,
      }),
    } as never)

    expect(res.status).toBe(401)
    expect(vi.mocked(portalCallback)).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const line = warnSpy.mock.calls[0]![0] as string
    // valid JSON, carries the correlation id, leaks NEITHER the expected nor the
    // provided secret value.
    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['correlationId']).toBe(CORR)
    expect(line).not.toContain(SECRET)
    expect(line).not.toContain('the-wrong-secret')
  })

  it('absent x-internal-auth → 401 + a structured console.warn (no secret required to be present)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await POST({
      request: req(PORTAL_PUBLISH_CONTRACT.request, { 'x-correlation-id': CORR }),
    } as never)

    expect(res.status).toBe(401)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(warnSpy.mock.calls[0]![0] as string) as Record<string, unknown>
    expect(parsed['correlationId']).toBe(CORR)
  })

  it('portalCallback throwing → stable 500 {success:false,error:"Internal error"} + structured console.error with correlation id', async () => {
    vi.mocked(portalCallback).mockRejectedValueOnce(new Error('db exploded'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await POST({
      request: req(PORTAL_PUBLISH_CONTRACT.request, {
        'x-internal-auth': SECRET,
        'x-correlation-id': CORR,
      }),
    } as never)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Internal error' })
    expect(errSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(errSpy.mock.calls[0]![0] as string) as Record<string, unknown>
    expect(parsed['correlationId']).toBe(CORR)
  })

  it('echoes an inbound x-correlation-id into the log line', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const inbound = '33333333-3333-3333-3333-333333333333'

    await POST({
      request: req(PORTAL_PUBLISH_CONTRACT.request, {
        'x-internal-auth': 'nope',
        'x-correlation-id': inbound,
      }),
    } as never)

    const line = warnSpy.mock.calls[0]![0] as string
    expect(line).toContain(inbound)
  })
})
