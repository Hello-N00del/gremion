import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET /api/content/posts/[id]/preview/[channel] — returns the channel's
// derive() model as JSON with a no-store cache header.

const { mockGetPost, mockListMedia, mockGetChannels, mockEmailDerive } = vi.hoisted(() => ({
  mockGetPost: vi.fn(),
  mockListMedia: vi.fn(),
  mockGetChannels: vi.fn(),
  mockEmailDerive: vi.fn(),
}))

vi.mock('$lib/auth', () => ({
  hasRole: (roles: string[], required: string) => roles.includes(required),
  Role: { Member: 'member' },
}))
vi.mock('$lib/server/content/content-db', () => ({
  getPost: mockGetPost,
  listMedia: mockListMedia,
  getChannels: mockGetChannels,
}))
vi.mock('$lib/server/content/channels/email-renderer', () => ({
  emailRenderer: { channel: 'email', derive: mockEmailDerive },
}))
vi.mock('$lib/server/content/channels/portal-renderer', () => ({
  portalRenderer: { channel: 'portal', derive: vi.fn() },
}))
vi.mock('$lib/server/content/channels/instagram-renderer', () => ({
  instagramRenderer: { channel: 'instagram', derive: vi.fn() },
}))

import { GET } from './+server'

// Content ids are UUIDs; the route answers 404 for anything else before a backend call.
const PID = '0b7c6f1e-4a8e-4c51-9f3a-2d1e8c7b6a50'
const BAD_ID = 'not-a-uuid'

type Ev = Parameters<typeof GET>[0]

function makeEvent(opts: {
  user?: { roles: string[]; groups: string[]; id: string } | null
  id?: string
  channel?: string
}): Ev {
  const channel = opts.channel ?? 'email'
  const id = opts.id ?? PID
  const request = new Request(`http://stura.test/api/content/posts/${id}/preview/${channel}`)
  return {
    request,
    locals: { user: opts.user ?? null },
    params: { id, channel },
  } as unknown as Ev
}

describe('GET /api/content/posts/[id]/preview/[channel]', () => {
  beforeEach(() => {
    mockGetPost.mockReset().mockResolvedValue({ id: PID, title: 'T', body_html: '<p>x</p>' })
    mockListMedia.mockReset().mockResolvedValue([])
    mockGetChannels
      .mockReset()
      .mockResolvedValue([{ post_id: PID, channel: 'email', enabled: true, overrides: {} }])
    mockEmailDerive.mockReset().mockReturnValue({ subject: 'T', html: '<p>x</p>', warnings: [] })
  })

  it('200s with the derive model and a no-store header', async () => {
    const res = await GET(makeEvent({ user: { roles: ['member'], groups: [], id: 'u1' } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({ subject: 'T', html: '<p>x</p>', warnings: [] })
    expect(mockEmailDerive).toHaveBeenCalledOnce()
  })

  it('401s when unauthenticated', async () => {
    await expect(GET(makeEvent({ user: null }))).rejects.toMatchObject({ status: 401 })
  })

  it('400s on an unknown channel', async () => {
    await expect(
      GET(makeEvent({ user: { roles: ['member'], groups: [], id: 'u1' }, channel: 'tiktok' })),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('404s on an unknown post', async () => {
    mockGetPost.mockResolvedValue(null)
    await expect(
      GET(makeEvent({ user: { roles: ['member'], groups: [], id: 'u1' } })),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('404s a malformed post id before any backend call', async () => {
    await expect(
      GET(makeEvent({ user: { roles: ['member'], groups: [], id: 'u1' }, id: BAD_ID })),
    ).rejects.toMatchObject({ status: 404 })
    expect(mockGetPost).not.toHaveBeenCalled()
  })
})
