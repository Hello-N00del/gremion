import { beforeEach, describe, expect, it, vi } from 'vitest'

// /api/content/lists — content engine's self-contained mailing lists.
// content.author gated; create validates a non-empty name.

const { mockComposeCapabilities, mockListLists, mockCreateList } = vi.hoisted(() => ({
  mockComposeCapabilities: vi.fn(),
  mockListLists: vi.fn(),
  mockCreateList: vi.fn(),
}))

vi.mock('$lib/auth', () => ({
  hasRole: (roles: string[], required: string) => roles.includes(required),
  Role: { Member: 'member' },
}))
vi.mock('$lib/modules/registry', () => ({ composeCapabilities: mockComposeCapabilities }))
vi.mock('$lib/server/content/content-db', () => ({
  listMailingLists: mockListLists,
  createMailingList: mockCreateList,
}))

import { GET, POST } from './+server'

type Ev = Parameters<typeof POST>[0]

function makeEvent(opts: {
  user?: { roles: string[]; groups: string[]; id: string } | null
  body?: unknown
}): Ev {
  return {
    request: new Request('http://stura.test/api/content/lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.body ?? {}),
    }),
    locals: { user: opts.user ?? null },
    params: {},
  } as unknown as Ev
}

const author = { roles: ['member'], groups: ['authors'], id: 'u1' }

describe('/api/content/lists', () => {
  beforeEach(() => {
    mockComposeCapabilities.mockReset().mockReturnValue({ 'content.author': ['authors'] })
    mockListLists.mockReset().mockResolvedValue([{ id: 'l1', name: 'A', created_at: 'x' }])
    mockCreateList.mockReset().mockResolvedValue({ id: 'l2', name: 'B', created_at: 'y' })
  })

  it('GET 403s a non-author', async () => {
    await expect(
      GET(makeEvent({ user: { roles: ['member'], groups: [], id: 'u1' } })),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('GET returns lists for an author', async () => {
    const res = await GET(makeEvent({ user: author }))
    expect(res.status).toBe(200)
    expect((await res.json()).lists).toHaveLength(1)
  })

  it('POST creates a list (201)', async () => {
    const res = await POST(makeEvent({ user: author, body: { name: 'B' } }))
    expect(res.status).toBe(201)
    expect(mockCreateList).toHaveBeenCalledWith('B')
  })

  it('POST 400s an empty name', async () => {
    await expect(POST(makeEvent({ user: author, body: { name: '  ' } }))).rejects.toMatchObject({
      status: 400,
    })
  })

  it('POST 401s with no user', async () => {
    await expect(POST(makeEvent({ user: null, body: { name: 'B' } }))).rejects.toMatchObject({
      status: 401,
    })
  })
})
