import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET /api/content/posts/[id]/carousel/[index] — a single slide PNG.

const { mockGetPost, mockListMedia, mockGetChannels, mockDerive, mockRenderSlidePng, mockReadConfig } =
  vi.hoisted(() => ({
    mockGetPost: vi.fn(),
    mockListMedia: vi.fn(),
    mockGetChannels: vi.fn(),
    mockDerive: vi.fn(),
    mockRenderSlidePng: vi.fn(),
    mockReadConfig: vi.fn(),
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
vi.mock('$lib/server/content/channels/instagram-renderer', () => ({
  instagramRenderer: { channel: 'instagram', derive: mockDerive },
}))
vi.mock('$lib/server/content/carousel/render', () => ({ renderSlidePng: mockRenderSlidePng }))
vi.mock('$lib/server/config', () => ({ readConfig: mockReadConfig }))

import { GET } from './+server'

type Ev = Parameters<typeof GET>[0]
const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function makeEvent(opts: {
  user?: { roles: string[]; groups: string[]; id: string } | null
  id?: string
  index?: string
}): Ev {
  const id = opts.id ?? 'p1'
  const index = opts.index ?? '0'
  const request = new Request(`http://stura.test/api/content/posts/${id}/carousel/${index}`)
  return {
    request,
    locals: { user: opts.user ?? null },
    params: { id, index },
  } as unknown as Ev
}

describe('GET /api/content/posts/[id]/carousel/[index]', () => {
  beforeEach(() => {
    mockGetPost.mockReset().mockResolvedValue({ id: 'p1', title: 'T', body_html: '<p>x</p>' })
    mockListMedia.mockReset().mockResolvedValue([])
    mockGetChannels
      .mockReset()
      .mockResolvedValue([{ post_id: 'p1', channel: 'instagram', enabled: true, overrides: {} }])
    mockDerive.mockReset().mockReturnValue({
      slides: [{ kind: 'cover', heading: 'T', body: '', imageUrl: null, index: 0, total: 1 }],
      caption: 'T',
      warnings: [],
    })
    mockRenderSlidePng.mockReset().mockResolvedValue(PNG_SIG)
    // A curated instance id (config.brand.palette is a registry id, NOT a raw
    // CSS colour). The route resolves it to a satori-safe hsl() in its hue.
    mockReadConfig.mockReset().mockReturnValue({ brand: { palette: 'stadt', logo_url: null } })
  })

  it('200s with image/png and the PNG bytes; resolves a curated palette to a satori-safe hsl()', async () => {
    const res = await GET(makeEvent({ user: { roles: ['member'], groups: [], id: 'u1' } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(bytes.slice(0, 8))).toEqual(Array.from(PNG_SIG))
    expect(mockRenderSlidePng).toHaveBeenCalledWith({
      // 'stadt' → curated hue 300 → hsl(300 45% 38%)
      brandTokens: { accent: 'hsl(300 45% 38%)', logoUrl: null },
      slide: { kind: 'cover', heading: 'T', body: '', imageUrl: null, index: 0, total: 1 },
    })
  })

  it('rejects an invalid palette value to the template fallback ("")', async () => {
    // config.brand.palette is a curated registry id; anything else is rejected
    // (resolvePaletteId → null) so the slide template keeps its own neutral default.
    mockReadConfig.mockReturnValue({ brand: { palette: '#7c3aed', logo_url: null } })
    await GET(makeEvent({ user: { roles: ['member'], groups: [], id: 'u1' } }))
    expect(mockRenderSlidePng).toHaveBeenCalledWith({
      brandTokens: { accent: '', logoUrl: null },
      slide: { kind: 'cover', heading: 'T', body: '', imageUrl: null, index: 0, total: 1 },
    })
  })

  it('401s when unauthenticated', async () => {
    await expect(GET(makeEvent({ user: null }))).rejects.toMatchObject({ status: 401 })
  })

  it('400s on a non-integer index', async () => {
    await expect(
      GET(makeEvent({ user: { roles: ['member'], groups: [], id: 'u1' }, index: 'x' })),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('404s when the slide index is out of range', async () => {
    await expect(
      GET(makeEvent({ user: { roles: ['member'], groups: [], id: 'u1' }, index: '5' })),
    ).rejects.toMatchObject({ status: 404 })
  })
})
