import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET / PATCH / DELETE /api/content/posts/[id].
// PATCH mirrors the news/[id] dual-auth: trusted internal Bearer OR a
// content.author session; supports title / body_html / channel-toggle edits.

const {
  mockIsInternalBearer,
  mockComposeCapabilities,
  mockGetPost,
  mockUpdateBody,
  mockUpdateTitle,
  mockDelete,
  mockSetEnabled,
  mockSetStatus,
  mockSetScheduledAt,
} = vi.hoisted(() => ({
  mockIsInternalBearer: vi.fn(),
  mockComposeCapabilities: vi.fn(),
  mockGetPost: vi.fn(),
  mockUpdateBody: vi.fn(),
  mockUpdateTitle: vi.fn(),
  mockDelete: vi.fn(),
  mockSetEnabled: vi.fn(),
  mockSetStatus: vi.fn(),
  mockSetScheduledAt: vi.fn(),
}))

vi.mock('$lib/auth', () => ({
  hasRole: (roles: string[], required: string) => roles.includes(required),
  Role: { Member: 'member' },
}))
vi.mock('$lib/modules/registry', () => ({ composeCapabilities: mockComposeCapabilities }))
vi.mock('$lib/server/internal-fetch', () => ({ isInternalBearerRequest: mockIsInternalBearer }))
vi.mock('$lib/server/security/html-sanitize', () => ({ sanitizeRichHtml: (s: string) => s }))
vi.mock('$lib/server/content/content-db', () => ({
  getPost: mockGetPost,
  updatePostBody: mockUpdateBody,
  updatePostTitle: mockUpdateTitle,
  deletePost: mockDelete,
  setChannelEnabled: mockSetEnabled,
  setChannelStatus: mockSetStatus,
  setChannelScheduledAt: mockSetScheduledAt,
}))

import { GET, PATCH, DELETE } from './+server'

// Content ids are UUIDs (F1-FIX-07 H08: the route 404s anything else).
const PID = '0b7c6f1e-4a8e-4c51-9f3a-2d1e8c7b6a50'

type Ev = Parameters<typeof PATCH>[0]

function makeEvent(opts: {
  user?: { roles: string[]; groups: string[]; id: string } | null
  body?: unknown
  id?: string
}): Ev {
  const request = new Request(`http://stura.test/api/content/posts/${opts.id ?? PID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.body ?? {}),
  })
  return {
    request,
    locals: { user: opts.user ?? null },
    params: { id: opts.id ?? PID },
  } as unknown as Ev
}

describe('/api/content/posts/[id]', () => {
  beforeEach(() => {
    mockIsInternalBearer.mockReset().mockReturnValue(false)
    mockComposeCapabilities.mockReset().mockReturnValue({ 'content.author': ['admin'] })
    mockGetPost.mockReset().mockResolvedValue({ id: PID, title: 'T' })
    mockUpdateBody.mockReset().mockResolvedValue({ id: PID })
    mockUpdateTitle.mockReset().mockResolvedValue({ id: PID })
    mockDelete.mockReset().mockResolvedValue(undefined)
    mockSetEnabled.mockReset().mockResolvedValue({ post_id: PID, channel: 'email', enabled: true })
    mockSetStatus.mockReset().mockResolvedValue({ post_id: PID, channel: 'email', status: 'scheduled' })
    mockSetScheduledAt
      .mockReset()
      .mockResolvedValue({ post_id: PID, channel: 'email', scheduled_at: null })
  })

  it('GET 200s the post for a Mitglied', async () => {
    const res = await GET(makeEvent({ user: { roles: ['member'], groups: [], id: 'u1' } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: PID, title: 'T' })
  })

  it('GET 404s an unknown post', async () => {
    mockGetPost.mockResolvedValue(null)
    await expect(
      GET(makeEvent({ user: { roles: ['member'], groups: [], id: 'u1' } })),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('PATCH 200s on a trusted internal Bearer without a content.author session', async () => {
    mockIsInternalBearer.mockReturnValue(true)
    const res = await PATCH(makeEvent({ user: null, body: { body_html: '<p>hi</p>' } }))
    expect(res.status).toBe(200)
    expect(mockUpdateBody).toHaveBeenCalledWith(PID, '<p>hi</p>')
  })

  it('PATCH falls back to content.author session auth when no Bearer', async () => {
    const res = await PATCH(
      makeEvent({ user: { roles: ['member'], groups: ['admin'], id: 'u1' }, body: { title: 'X' } }),
    )
    expect(res.status).toBe(200)
    expect(mockUpdateTitle).toHaveBeenCalledWith(PID, 'X')
  })

  it('PATCH 403s with neither Bearer nor content.author', async () => {
    await expect(
      PATCH(makeEvent({ user: { roles: ['member'], groups: [], id: 'u1' }, body: { title: 'X' } })),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('PATCH toggles a channel via setChannelEnabled', async () => {
    mockIsInternalBearer.mockReturnValue(true)
    const res = await PATCH(makeEvent({ user: null, body: { channel: 'email', enabled: true } }))
    expect(res.status).toBe(200)
    expect(mockSetEnabled).toHaveBeenCalledWith(PID, 'email', true)
  })

  it('PATCH 400s on an invalid channel', async () => {
    mockIsInternalBearer.mockReturnValue(true)
    await expect(
      PATCH(makeEvent({ user: null, body: { channel: 'tiktok', enabled: true } })),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('PATCH arms a scheduled publish (scheduled_at + status=scheduled)', async () => {
    mockIsInternalBearer.mockReturnValue(true)
    const at = '2026-07-01T10:00:00.000Z'
    const res = await PATCH(makeEvent({ user: null, body: { channel: 'email', scheduled_at: at } }))
    expect(res.status).toBe(200)
    expect(mockSetScheduledAt).toHaveBeenCalledWith(PID, 'email', at)
    expect(mockSetStatus).toHaveBeenCalledWith(PID, 'email', 'scheduled')
  })

  it('PATCH clears a schedule (scheduled_at=null → status=draft)', async () => {
    mockIsInternalBearer.mockReturnValue(true)
    const res = await PATCH(makeEvent({ user: null, body: { channel: 'portal', scheduled_at: null } }))
    expect(res.status).toBe(200)
    expect(mockSetScheduledAt).toHaveBeenCalledWith(PID, 'portal', null)
    expect(mockSetStatus).toHaveBeenCalledWith(PID, 'portal', 'draft')
  })

  it('PATCH 400s a non-ISO scheduled_at', async () => {
    mockIsInternalBearer.mockReturnValue(true)
    await expect(
      PATCH(makeEvent({ user: null, body: { channel: 'email', scheduled_at: 'not-a-date' } })),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('PATCH 400s a channel op with neither enabled nor scheduled_at', async () => {
    mockIsInternalBearer.mockReturnValue(true)
    await expect(
      PATCH(makeEvent({ user: null, body: { channel: 'email' } })),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('PATCH 400s on an empty PATCH body', async () => {
    mockIsInternalBearer.mockReturnValue(true)
    await expect(PATCH(makeEvent({ user: null, body: {} }))).rejects.toMatchObject({ status: 400 })
  })

  it('DELETE 200s for a content.author', async () => {
    const res = await DELETE(
      makeEvent({ user: { roles: ['member'], groups: ['admin'], id: 'u1' } }),
    )
    expect(res.status).toBe(200)
    expect(mockDelete).toHaveBeenCalledWith(PID)
  })

  it('DELETE 403s for a non-author', async () => {
    await expect(
      DELETE(makeEvent({ user: { roles: ['member'], groups: [], id: 'u1' } })),
    ).rejects.toMatchObject({ status: 403 })
    expect(mockDelete).not.toHaveBeenCalled()
  })

  // F1-FIX-07 H08 (K5#27): SvelteKit decodes %2F, so GET
  // /api/content/posts/x%2F..%2F..%2Flists arrives as id "x/../../lists". It is
  // a 404 before any backend call — never a walk to the leaf's /api/v1/lists.
  it.each(['x/../../lists', '..', 'p1', '1 OR 1=1'])('GET 404s the non-UUID id %j without a backend call', async (id) => {
    await expect(
      GET(makeEvent({ user: { roles: ['member'], groups: [], id: 'u1' }, id })),
    ).rejects.toMatchObject({ status: 404 })
    expect(mockGetPost).not.toHaveBeenCalled()
  })

  it('PATCH and DELETE 404 a traversal id without a backend call', async () => {
    mockIsInternalBearer.mockReturnValue(true)
    await expect(
      PATCH(makeEvent({ user: null, id: 'x/../../lists', body: { title: 'X' } })),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      DELETE(makeEvent({ user: { roles: ['member'], groups: ['admin'], id: 'u1' }, id: '../lists' })),
    ).rejects.toMatchObject({ status: 404 })
    expect(mockGetPost).not.toHaveBeenCalled()
    expect(mockUpdateTitle).not.toHaveBeenCalled()
    expect(mockDelete).not.toHaveBeenCalled()
  })
})
