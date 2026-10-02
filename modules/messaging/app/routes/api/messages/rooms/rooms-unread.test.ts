// #188: GET /api/messages/rooms previously hardcoded `unreadCount: 0` for every
// room, so the messages list always showed 0 unread on initial load. The
// MatrixClient already derives per-room *message* unread counts from
// /notifications (excluding the invite_for_me membership notification). This
// test asserts the handler surfaces that real count instead of a hardcoded 0.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth/types'

const { mockGetMatrixToken, mockGetJoinedRooms, mockUnread } = vi.hoisted(() => ({
  mockGetMatrixToken: vi.fn(),
  mockGetJoinedRooms: vi.fn(),
  mockUnread: vi.fn(),
}))

vi.mock('$lib/server/messages/matrix-client', () => ({
  getMatrixClient: () => ({
    getMatrixToken: mockGetMatrixToken,
    getJoinedRooms: mockGetJoinedRooms,
    unreadMessageCountsByRoom: mockUnread,
    sync: vi.fn(),
  }),
}))

vi.mock('$lib/server/messages/synapse-admin', () => ({
  getSynapseAdmin: () => ({ forceJoinRoom: vi.fn().mockResolvedValue(undefined) }),
}))

vi.mock('$env/dynamic/private', () => ({
  env: new Proxy({}, { get: () => 'sentinel' }),
}))

// The handler fetches m.room.name state per room via global fetch; return a name.
vi.stubGlobal(
  'fetch',
  async () =>
    new Response(JSON.stringify({ name: 'Raum Eins' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
)

let GET: (event: unknown) => Promise<Response>

beforeEach(async () => {
  mockGetMatrixToken.mockReset().mockResolvedValue('matrix-token-abc')
  mockGetJoinedRooms.mockReset().mockResolvedValue(['!room1:matrix.example'])
  mockUnread.mockReset().mockResolvedValue(new Map([['!room1:matrix.example', 3]]))
  GET = (await import('./+server')).GET as (event: unknown) => Promise<Response>
})

function event() {
  const user = {
    id: 'u',
    roles: [Role.Member],
    groups: [],
    email: 'u@example.org',
    name: 'u',
    preferredUsername: 'u',
  }
  return {
    locals: {
      user,
      accessToken: 'kc-jwt',
      auth: async () => ({ user, accessToken: 'kc-jwt', expires: '2099-01-01T00:00:00.000Z' }),
    },
    params: {},
    request: new Request('http://localhost/api/messages/rooms', {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
    }),
    url: new URL('http://localhost/api/messages/rooms'),
    fetch: async () => new Response('{}', { status: 200 }),
  }
}

describe('#188 GET /api/messages/rooms unread count', () => {
  it('reports the real per-room unread count, not a hardcoded 0', async () => {
    const res = await GET(event())
    expect(res.status, await res.clone().text()).toBe(200)
    const body = await res.json()
    const room = body.data.find((r: { roomId: string }) => r.roomId === '!room1:matrix.example')
    expect(room.unreadCount).toBe(3)
  })
})
