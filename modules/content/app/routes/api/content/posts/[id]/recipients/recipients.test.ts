import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET / PUT /api/content/posts/[id]/recipients — the email recipient set.
// content.author gated; PUT validates the XOR (list OR group, never both/neither).

const {
  mockComposeCapabilities,
  mockGetPost,
  mockGetRecipients,
  mockSetRecipients,
  mockListLists,
  mockKcClient,
  mockListGroups,
} = vi.hoisted(() => ({
  mockComposeCapabilities: vi.fn(),
  mockGetPost: vi.fn(),
  mockGetRecipients: vi.fn(),
  mockSetRecipients: vi.fn(),
  mockListLists: vi.fn(),
  mockKcClient: vi.fn(),
  mockListGroups: vi.fn(),
}))

vi.mock('$lib/auth', () => ({
  hasRole: (roles: string[], required: string) => roles.includes(required),
  Role: { Member: 'member' },
}))
vi.mock('$lib/modules/registry', () => ({ composeCapabilities: mockComposeCapabilities }))
vi.mock('$lib/server/content/content-db', () => ({
  getPost: mockGetPost,
  getPostRecipients: mockGetRecipients,
  setPostRecipients: mockSetRecipients,
  listMailingLists: mockListLists,
}))
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClientForCurrentTenant: mockKcClient,
}))

import { GET, PUT } from './+server'

type Ev = Parameters<typeof PUT>[0]

function makeEvent(opts: {
  user?: { roles: string[]; groups: string[]; id: string } | null
  body?: unknown
}): Ev {
  return {
    request: new Request('http://stura.test/api/content/posts/p1/recipients', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.body ?? {}),
    }),
    locals: { user: opts.user ?? null },
    params: { id: 'p1' },
  } as unknown as Ev
}

describe('/api/content/posts/[id]/recipients', () => {
  beforeEach(() => {
    mockComposeCapabilities.mockReset().mockReturnValue({ 'content.author': ['authors'] })
    mockGetPost.mockReset().mockResolvedValue({ id: 'p1', title: 'T' })
    mockGetRecipients.mockReset().mockResolvedValue([])
    mockSetRecipients.mockReset().mockResolvedValue(undefined)
    mockListLists.mockReset().mockResolvedValue([{ id: 'l1', name: 'A', created_at: 'x' }])
    mockListGroups.mockReset().mockResolvedValue([{ id: 'g1', name: 'StuRa', path: '/StuRa' }])
    mockKcClient.mockReset().mockReturnValue({ listGroups: mockListGroups })
  })

  it('GET 401s with no user', async () => {
    await expect(GET(makeEvent({ user: null }))).rejects.toMatchObject({ status: 401 })
  })

  it('GET 403s a non-author', async () => {
    await expect(
      GET(makeEvent({ user: { roles: ['member'], groups: [], id: 'u1' } })),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('GET returns recipients + lists + groups', async () => {
    const res = await GET(makeEvent({ user: { roles: ['member'], groups: ['authors'], id: 'u1' } }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.lists).toHaveLength(1)
    expect(data.groups).toEqual([{ id: 'g1', name: 'StuRa', path: '/StuRa' }])
  })

  it('GET degrades gracefully when the KC group lookup fails', async () => {
    mockListGroups.mockRejectedValue(new Error('kc down'))
    const res = await GET(makeEvent({ user: { roles: ['member'], groups: ['authors'], id: 'u1' } }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.groups).toEqual([])
    expect(data.lists).toHaveLength(1)
  })

  it('PUT replaces the recipient set', async () => {
    const res = await PUT(
      makeEvent({
        user: { roles: ['member'], groups: ['authors'], id: 'u1' },
        body: { recipients: [{ mailing_list_id: 'l1' }, { keycloak_group_id: 'g1' }] },
      }),
    )
    expect(res.status).toBe(200)
    expect(mockSetRecipients).toHaveBeenCalledWith('p1', [
      { mailing_list_id: 'l1' },
      { keycloak_group_id: 'g1' },
    ])
  })

  it('PUT 400s an entry targeting both a list and a group', async () => {
    await expect(
      PUT(
        makeEvent({
          user: { roles: ['member'], groups: ['authors'], id: 'u1' },
          body: { recipients: [{ mailing_list_id: 'l1', keycloak_group_id: 'g1' }] },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 })
    expect(mockSetRecipients).not.toHaveBeenCalled()
  })

  it('PUT 400s an entry targeting neither', async () => {
    await expect(
      PUT(
        makeEvent({
          user: { roles: ['member'], groups: ['authors'], id: 'u1' },
          body: { recipients: [{}] },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('PUT 400s when recipients is not an array', async () => {
    await expect(
      PUT(
        makeEvent({
          user: { roles: ['member'], groups: ['authors'], id: 'u1' },
          body: { recipients: 'nope' },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 })
  })
})
