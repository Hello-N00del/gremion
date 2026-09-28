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

type Ev = Parameters<typeof GET>[0]

function makeEvent(opts: {
  user?: { roles: string[]; groups: string[]; id: string } | null
  id?: string
  channel?: string
}): Ev {
  const channel = opts.channel ?? 'email'
  const id = opts.id ?? 'p1'
  const request = new Request(`http://stura.test/api/content/posts/${id}/preview/${channel}`)
  return {
    request,
    locals: { user: opts.user ?? null },
    params: { id, channel },
  } as unknown as Ev
}

describe('GET /api/content/posts/[id]/preview/[channel]', () => {
  beforeEach(() => {
    mockGetPost.mockReset().mockResolvedValue({ id: 'p1', title: 'T', body_html: '<p>x</p>' })
    mockListMedia.mockReset().mockResolvedValue([])
    mockGetChannels
      .mockReset()
      .mockResolvedValue([{ post_id: 'p1', channel: 'email', enabled: true, overrides: {} }])
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
})
