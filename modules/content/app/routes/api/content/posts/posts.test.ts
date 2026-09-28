import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET /api/content/posts (list, Role.Member view gate) +
// POST /api/content/posts (create, content.author capability).

const { mockListPosts, mockCreatePost, mockComposeCapabilities } = vi.hoisted(() => ({
  mockListPosts: vi.fn(),
  mockCreatePost: vi.fn(),
  mockComposeCapabilities: vi.fn(),
}))

vi.mock('$lib/auth', () => ({
  hasRole: (roles: string[], required: string) => roles.includes(required),
  Role: { Member: 'member' },
}))

vi.mock('$lib/modules/registry', () => ({
  composeCapabilities: mockComposeCapabilities,
}))

vi.mock('$lib/server/content/content-db', () => ({
  listPosts: mockListPosts,
  createPost: mockCreatePost,
}))

import { GET, POST } from './+server'

type GetEvent = Parameters<typeof GET>[0]
type PostEvent = Parameters<typeof POST>[0]

function makeEvent(opts: {
  user?: { roles: string[]; groups: string[]; id: string } | null
  body?: unknown
}): GetEvent & PostEvent {
  const request = new Request('http://stura.test/api/content/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.body ?? {}),
  })
  return { request, locals: { user: opts.user ?? null } } as unknown as GetEvent & PostEvent
}

describe('/api/content/posts', () => {
  beforeEach(() => {
    mockListPosts.mockReset().mockResolvedValue([{ id: 'p1', title: 'A' }])
    mockCreatePost.mockReset().mockResolvedValue({ id: 'p2', title: 'New' })
    mockComposeCapabilities.mockReset().mockReturnValue({ 'content.author': ['admin', 'it-admin'] })
  })

  it('GET 200s for a Mitglied and returns the list', async () => {
    const res = await GET(makeEvent({ user: { roles: ['member'], groups: [], id: 'u1' } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ id: 'p1', title: 'A' }])
  })

  it('GET 401s when unauthenticated', async () => {
    await expect(GET(makeEvent({ user: null }))).rejects.toMatchObject({ status: 401 })
  })

  it('GET 403s when not a Mitglied', async () => {
    await expect(
      GET(makeEvent({ user: { roles: ['guest'], groups: [], id: 'u1' } })),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('POST 201s and creates for a content.author', async () => {
    const res = await POST(
      makeEvent({ user: { roles: ['member'], groups: ['admin'], id: 'u1' }, body: { title: 'New' } }),
    )
    expect(res.status).toBe(201)
    expect(mockCreatePost).toHaveBeenCalledWith({ title: 'New', created_by: 'u1' })
  })

  it('POST 403s for a member who lacks the content.author group', async () => {
    await expect(
      POST(makeEvent({ user: { roles: ['member'], groups: [], id: 'u1' }, body: { title: 'New' } })),
    ).rejects.toMatchObject({ status: 403 })
    expect(mockCreatePost).not.toHaveBeenCalled()
  })

  it('POST 400s on a missing title', async () => {
    await expect(
      POST(makeEvent({ user: { roles: ['member'], groups: ['admin'], id: 'u1' }, body: {} })),
    ).rejects.toMatchObject({ status: 400 })
  })
})
