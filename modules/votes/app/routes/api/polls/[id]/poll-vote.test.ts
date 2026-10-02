import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET, POST } from './+server'

const { mockGetPoll, mockGetPollWithOptions, mockVote, mockCreatePollsClient } = vi.hoisted(() => {
  const mockGetPoll = vi.fn()
  const mockGetPollWithOptions = vi.fn()
  const mockVote = vi.fn()
  return {
    mockGetPoll,
    mockGetPollWithOptions,
    mockVote,
    mockCreatePollsClient: vi.fn(() => ({
      getPoll: mockGetPoll,
      getPollWithOptions: mockGetPollWithOptions,
      vote: mockVote,
    })),
  }
})

const { mockHasRole } = vi.hoisted(() => ({ mockHasRole: vi.fn() }))

vi.mock('$lib/server/polls/polls-client', () => ({
  createPollsClient: mockCreatePollsClient,
  NextcloudPollsClient: {
    getPoll: mockGetPoll,
    getPollWithOptions: mockGetPollWithOptions,
    vote: mockVote,
  },
}))

vi.mock('$lib/auth', () => ({
  hasRole: mockHasRole,
  Role: { Member: 'member' },
}))

const mockPoll = {
  id: 1,
  configuration: { title: 'Test', description: '', isAnonymous: false, allowComment: false, expire: 0 },
  status: { isExpired: false, isLocked: false },
  currentUserStatus: { userRole: 'voter', hasVoted: false },
  votes: { count: 0 },
  options: [{ id: 10, text: 'Ja', votes: 0 }],
}

function makeLocals(roles: string[]) {
  return { accessToken: 'kc-token', auth: async () => ({ user: { roles } }) }
}

// Same as makeLocals but with no accessToken — exercises the fail-closed path
// where there is no per-user OIDC bearer to cast the vote as (item 3a).
function makeLocalsNoToken(roles: string[]) {
  return { auth: async () => ({ user: { roles } }) }
}

// Reset call history between tests so per-test assertions on the mocked
// createPollsClient/vote calls (e.g. the #411 oidcBearer pins) can't be
// polluted by an earlier test's invocations.
beforeEach(() => vi.clearAllMocks())

describe('GET /api/polls/[id]', () => {
  it('returns poll for members', async () => {
    mockHasRole.mockReturnValue(true)
    mockGetPollWithOptions.mockResolvedValue(mockPoll)

    // @ts-expect-error partial mock
    const response = await GET({ params: { id: '1' }, locals: makeLocals(['member']) })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.id).toBe(1)
    // #411 pin: the poll must be fetched with the acting user's OIDC bearer,
    // not the admin singleton, so hasVoted/lock state is per-user.
    expect(mockCreatePollsClient).toHaveBeenCalledWith({ oidcBearer: 'kc-token' })
  })

  it('returns 403 for guests', async () => {
    mockHasRole.mockReturnValue(false)

    // @ts-expect-error partial mock
    const response = await GET({ params: { id: '1' }, locals: makeLocals(['guest']) })
    expect(response.status).toBe(403)
  })
})

describe('POST /api/polls/[id] (vote)', () => {
  it('records vote and returns voted: true', async () => {
    mockHasRole.mockReturnValue(true)
    mockVote.mockResolvedValue({ ok: true })

    const request = new Request('http://localhost/api/polls/1', {
      method: 'POST',
      body: JSON.stringify({ optionId: 10 }),
    })

    // @ts-expect-error partial mock
    const response = await POST({ params: { id: '1' }, request, locals: makeLocals(['member']) })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.voted).toBe(true)
    expect(mockVote).toHaveBeenCalledWith(1, 10)
    // #411 pin: the vote must be cast AS the acting user via their OIDC bearer
    // — voting as the shared admin locked the poll for every other user.
    expect(mockCreatePollsClient).toHaveBeenCalledWith({ oidcBearer: 'kc-token' })
  })

  it('returns 400 for invalid optionId', async () => {
    mockHasRole.mockReturnValue(true)

    const request = new Request('http://localhost/api/polls/1', {
      method: 'POST',
      body: JSON.stringify({ optionId: 'not-a-number' }),
    })

    // @ts-expect-error partial mock
    const response = await POST({ params: { id: '1' }, request, locals: makeLocals(['member']) })
    expect(response.status).toBe(400)
  })

  it('returns 403 for guests', async () => {
    mockHasRole.mockReturnValue(false)

    const request = new Request('http://localhost/api/polls/1', {
      method: 'POST',
      body: JSON.stringify({ optionId: 10 }),
    })

    // @ts-expect-error partial mock
    const response = await POST({ params: { id: '1' }, request, locals: makeLocals(['guest']) })
    expect(response.status).toBe(403)
  })

  it('fails closed with 401 when a member has no accessToken (item 3a)', async () => {
    mockHasRole.mockReturnValue(true)

    const request = new Request('http://localhost/api/polls/1', {
      method: 'POST',
      body: JSON.stringify({ optionId: 10 }),
    })

    // @ts-expect-error partial mock
    const response = await POST({ params: { id: '1' }, request, locals: makeLocalsNoToken(['member']) })
    expect(response.status).toBe(401)
    // Without a per-user OIDC bearer the vote must NOT fall back to the shared
    // admin Basic-auth (which would lock the poll for everyone) — never call
    // client.vote() at all.
    expect(mockVote).not.toHaveBeenCalled()
    expect(mockCreatePollsClient).not.toHaveBeenCalled()
  })
})
