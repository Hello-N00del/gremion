import { beforeEach, describe, expect, it, vi } from 'vitest'

// G-075 — /api/news/[id] PATCH must accept either a CouncilAdmin
// session OR a trusted internal Bearer header (mirrors the minutes
// dual-auth shape). The Bearer path short-circuits the role check
// because the in-process producer holding the shared secret is
// already trusted.

const { mockIsInternalBearerRequest, mockHasRole, mockPublish, mockUnpublish, mockUpdateBody, mockGet } =
  vi.hoisted(() => ({
    mockIsInternalBearerRequest: vi.fn(),
    mockHasRole: vi.fn(),
    mockPublish: vi.fn(),
    mockUnpublish: vi.fn(),
    mockUpdateBody: vi.fn(),
    mockGet: vi.fn(),
  }))

vi.mock('$lib/server/internal-fetch', () => ({
  isInternalBearerRequest: mockIsInternalBearerRequest,
}))

vi.mock('$lib/auth', () => ({
  hasRole: mockHasRole,
  Role: { CouncilAdmin: 'council_admin' },
}))

vi.mock('$lib/server/news/news-db', () => ({
  getNewsPostById: mockGet,
  updateNewsBodyHtml: mockUpdateBody,
  publishNewsPost: mockPublish,
  unpublishNewsPost: mockUnpublish,
  deleteNewsPost: vi.fn(),
}))

vi.mock('$lib/server/security/html-sanitize', () => ({
  sanitizeRichHtml: (s: string) => s,
}))

import { PATCH } from './+server'

type RouteEvent = Parameters<typeof PATCH>[0]

function makeEvent(opts: { user?: { roles: string[] } | null; body: unknown; id?: string }): RouteEvent {
  const request = new Request(`http://stura.test/api/news/${opts.id ?? '1'}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.body),
  })
  const locals = {
    auth: vi.fn(async () => (opts.user ? { user: opts.user } : null)),
  }
  return { request, locals, params: { id: opts.id ?? '1' } } as unknown as RouteEvent
}

describe('PATCH /api/news/[id] — G-075 dual-auth', () => {
  beforeEach(() => {
    mockIsInternalBearerRequest.mockReset()
    mockHasRole.mockReset()
    mockPublish.mockReset().mockResolvedValue(undefined)
    mockUnpublish.mockReset().mockResolvedValue(undefined)
    mockUpdateBody.mockReset().mockResolvedValue(undefined)
    mockGet.mockReset().mockResolvedValue({ id: 1, title: 'Test' })
  })

  it('200s on a trusted internal Bearer request without invoking locals.auth() or hasRole', async () => {
    mockIsInternalBearerRequest.mockReturnValue(true)
    const event = makeEvent({ user: null, body: { action: 'publish' } })
    const res = await PATCH(event)
    expect(res.status).toBe(200)
    expect(mockHasRole).not.toHaveBeenCalled()
    expect(mockPublish).toHaveBeenCalledWith(1)
  })

  it('falls back to session-cookie auth when no Bearer is supplied', async () => {
    mockIsInternalBearerRequest.mockReturnValue(false)
    mockHasRole.mockReturnValue(true)
    const event = makeEvent({ user: { roles: ['council_admin'] }, body: { action: 'unpublish' } })
    const res = await PATCH(event)
    expect(res.status).toBe(200)
    expect(mockHasRole).toHaveBeenCalledOnce()
    expect(mockUnpublish).toHaveBeenCalledWith(1)
  })

  it('403s when neither Bearer nor a CouncilAdmin session is supplied', async () => {
    mockIsInternalBearerRequest.mockReturnValue(false)
    mockHasRole.mockReturnValue(false)
    const event = makeEvent({ user: { roles: ['member'] }, body: { action: 'publish' } })
    await expect(PATCH(event)).rejects.toMatchObject({ status: 403 })
    expect(mockPublish).not.toHaveBeenCalled()
  })

  it('400s on an invalid PATCH body (no action, no body_html)', async () => {
    mockIsInternalBearerRequest.mockReturnValue(true)
    const event = makeEvent({ user: null, body: {} })
    await expect(PATCH(event)).rejects.toMatchObject({ status: 400 })
  })
})
