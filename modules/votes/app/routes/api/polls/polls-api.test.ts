import { describe, expect, it, vi } from 'vitest'
import { GET, POST } from './+server'

const { mockListPolls, mockCreatePoll, mockCreatePollsClient } = vi.hoisted(() => {
  const mockListPolls = vi.fn()
  const mockCreatePoll = vi.fn()
  return {
    mockListPolls,
    mockCreatePoll,
    mockCreatePollsClient: vi.fn(() => ({
      listPolls: mockListPolls,
      createPoll: mockCreatePoll,
    })),
  }
})

const { mockHasRole } = vi.hoisted(() => ({ mockHasRole: vi.fn() }))

vi.mock('$lib/server/polls/polls-client', () => ({
  createPollsClient: mockCreatePollsClient,
  NextcloudPollsClient: {
    listPolls: mockListPolls,
    createPoll: mockCreatePoll,
  },
}))

vi.mock('$lib/auth', () => ({
  hasRole: mockHasRole,
  Role: { Member: 'member', CouncilAdmin: 'council-admin' },
}))

const mockPoll = {
  id: 1,
  configuration: { title: 'Test', description: '', isAnonymous: false, allowComment: false, expire: 0 },
  status: { isExpired: false, isLocked: false },
  currentUserStatus: { userRole: 'voter', hasVoted: false },
  votes: { count: 0 },
  options: [],
}

function makeLocals(roles: string[]) {
  return { accessToken: 'kc-token', auth: async () => ({ user: { roles } }) }
}

describe('GET /api/polls', () => {
  it('returns poll list for members', async () => {
    mockHasRole.mockReturnValue(true)
    mockListPolls.mockResolvedValue([mockPoll])

    // @ts-expect-error partial mock
    const response = await GET({ locals: makeLocals(['member']) })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data).toHaveLength(1)
    // #411 pin: the list must be fetched with the acting user's OIDC bearer so
    // each poll's currentUserStatus is per-user, not the shared admin's.
    expect(mockCreatePollsClient).toHaveBeenCalledWith({ oidcBearer: 'kc-token' })
  })

  it('returns 403 for guests', async () => {
    mockHasRole.mockReturnValue(false)

    // @ts-expect-error partial mock
    const response = await GET({ locals: makeLocals(['guest']) })
    expect(response.status).toBe(403)
  })
})

describe('POST /api/polls', () => {
  it('creates poll for council-admin', async () => {
    mockHasRole.mockReturnValue(true)
    mockCreatePoll.mockResolvedValue(mockPoll)

    const request = new Request('http://localhost/api/polls', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Neue Umfrage',
        type: 'textPoll',
        options: ['Ja', 'Nein'],
        anonymous: false,
      }),
    })

    // @ts-expect-error partial mock
    const response = await POST({ request, locals: makeLocals(['council-admin']) })
    expect(response.status).toBe(201)
  })

  it('returns 400 for invalid body (fewer than 2 options)', async () => {
    mockHasRole.mockReturnValue(true)

    const request = new Request('http://localhost/api/polls', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Test', type: 'textPoll', options: ['Only One'], anonymous: false }),
    })

    // @ts-expect-error partial mock
    const response = await POST({ request, locals: makeLocals(['council-admin']) })
    expect(response.status).toBe(400)
  })

  it('returns 403 for members (not council-admin)', async () => {
    mockHasRole.mockReturnValue(false)

    const request = new Request('http://localhost/api/polls', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'T', type: 'textPoll', options: ['A', 'B'], anonymous: false }),
    })

    // @ts-expect-error partial mock
    const response = await POST({ request, locals: makeLocals(['member']) })
    expect(response.status).toBe(403)
  })
})
