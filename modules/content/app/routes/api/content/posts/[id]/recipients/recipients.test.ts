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
  mockListGroupTree,
  mockGetGroup,
} = vi.hoisted(() => ({
  mockComposeCapabilities: vi.fn(),
  mockGetPost: vi.fn(),
  mockGetRecipients: vi.fn(),
  mockSetRecipients: vi.fn(),
  mockListLists: vi.fn(),
  mockKcClient: vi.fn(),
  mockListGroupTree: vi.fn(),
  mockGetGroup: vi.fn(),
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
    mockListGroupTree.mockReset().mockResolvedValue([{ id: 'g1', name: 'StuRa', path: '/StuRa' }])
    mockGetGroup.mockReset().mockResolvedValue({ id: 'g1', name: 'StuRa', path: '/StuRa' })
    mockKcClient.mockReset().mockReturnValue({ listGroupTree: mockListGroupTree, getGroup: mockGetGroup })
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
    mockListGroupTree.mockRejectedValue(new Error('kc down'))
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

  it('GET lists nested groups with their full path', async () => {
    mockListGroupTree.mockResolvedValue([
      { id: 'g1', name: 'Studierendenrat', path: '/Studierendenrat', subGroupCount: 1 },
      { id: 'g2', name: 'Vorstand', path: '/Studierendenrat/Vorstand' },
    ])
    const res = await GET(makeEvent({ user: { roles: ['member'], groups: ['authors'], id: 'u1' } }))
    const data = await res.json()
    expect(data.groups).toEqual([
      { id: 'g1', name: 'Studierendenrat', path: '/Studierendenrat' },
      { id: 'g2', name: 'Vorstand', path: '/Studierendenrat/Vorstand' },
    ])
  })

  const author = { roles: ['member'], groups: ['authors'], id: 'u1' }

  it('PUT 400s a group that Keycloak does not know, with the id in the message, and stores nothing', async () => {
    mockGetGroup.mockRejectedValue(Object.assign(new Error('Keycloak Admin API error: 404 {}'), { status: 404 }))
    await expect(
      PUT(makeEvent({ user: author, body: { recipients: [{ keycloak_group_id: 'typo' }] } })),
    ).rejects.toMatchObject({ status: 400, body: { message: 'Gruppe nicht gefunden: typo' } })
    expect(mockGetGroup).toHaveBeenCalledWith('typo')
    expect(mockSetRecipients).not.toHaveBeenCalled()
  })

  it('PUT 400s a group id that cannot be a path segment', async () => {
    mockGetGroup.mockRejectedValue(Object.assign(new Error('Invalid Keycloak id'), { name: 'KcInvalidIdError' }))
    await expect(
      PUT(makeEvent({ user: author, body: { recipients: [{ keycloak_group_id: '..' }] } })),
    ).rejects.toMatchObject({ status: 400 })
    expect(mockSetRecipients).not.toHaveBeenCalled()
  })

  it('PUT accepts the set when Keycloak is down, so mailing lists can still be saved', async () => {
    mockGetGroup.mockRejectedValue(new Error('kc down'))
    const res = await PUT(makeEvent({ user: author, body: { recipients: [{ keycloak_group_id: 'g1' }] } }))
    expect(res.status).toBe(200)
    expect(mockSetRecipients).toHaveBeenCalledWith('p1', [{ keycloak_group_id: 'g1' }])
  })

  it('PUT checks each distinct group id once, however often it is listed', async () => {
    const res = await PUT(
      makeEvent({
        user: author,
        body: { recipients: [{ keycloak_group_id: 'g1' }, { keycloak_group_id: 'g1' }, { keycloak_group_id: 'g2' }] },
      }),
    )
    expect(res.status).toBe(200)
    expect(mockGetGroup).toHaveBeenCalledTimes(2)
  })

  it('PUT stops asking Keycloak after the first failure that is not a definite miss', async () => {
    mockGetGroup.mockRejectedValue(new Error('kc down'))
    const ids = ['g1', 'g2', 'g3', 'g4', 'g5']
    const res = await PUT(
      makeEvent({ user: author, body: { recipients: ids.map((id) => ({ keycloak_group_id: id })) } }),
    )
    expect(res.status).toBe(200)
    expect(mockGetGroup).toHaveBeenCalledTimes(1)
  })

  it('PUT 400s an audience of more than 200 entries without asking Keycloak', async () => {
    const recipients = Array.from({ length: 201 }, (_, i) => ({ keycloak_group_id: `g${i}` }))
    await expect(PUT(makeEvent({ user: author, body: { recipients } }))).rejects.toMatchObject({ status: 400 })
    expect(mockGetGroup).not.toHaveBeenCalled()
    expect(mockSetRecipients).not.toHaveBeenCalled()
  })

  it('PUT with mailing lists only does not ask Keycloak at all', async () => {
    const res = await PUT(makeEvent({ user: author, body: { recipients: [{ mailing_list_id: 'l1' }] } }))
    expect(res.status).toBe(200)
    expect(mockKcClient).not.toHaveBeenCalled()
    expect(mockGetGroup).not.toHaveBeenCalled()
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
