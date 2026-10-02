// F1-FIX-04 (H18 / S3#25, S1c#18; operator decision D-3): the mobile token
// exchange GET /api/auth/matrix-token ran the same "join every server room"
// first-login backfill as /api/messages/rooms, for any caller -- Guests
// included -- into committee_only rooms too. Now it uses the same scoped
// helper: no Guest auto-join, a Member only into the rooms of their own units.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth/types'

const h = vi.hoisted(() => ({
  getMatrixToken: vi.fn(),
  getJoinedRooms: vi.fn(),
  listAllRoomIds: vi.fn(),
  forceJoinRoom: vi.fn(),
  marker: vi.fn(),
  unitRooms: {} as Record<string, string[]>,
}))

vi.mock('$lib/server/messages/backend', () => ({
  getMessagesBackend: () => ({
    matrix: () => ({ getMatrixToken: h.getMatrixToken, getJoinedRooms: h.getJoinedRooms }),
    synapse: () => ({ listAllRoomIds: h.listAllRoomIds, forceJoinRoom: h.forceJoinRoom }),
  }),
}))
vi.mock('$lib/server/messages/admin/room-admin', () => ({
  getRoomArchiveMarker: h.marker,
  createRoom: vi.fn(),
}))
vi.mock('$lib/server/db', () => ({
  getDb: () => (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?')
    if (q.includes('provisioning_resources')) {
      const userId = values.find((v) => typeof v === 'string' && v in h.unitRooms) as string | undefined
      return Promise.resolve((userId ? h.unitRooms[userId]! : []).map((roomId) => ({ roomId })))
    }
    return Promise.resolve([])
  },
}))
vi.stubGlobal('fetch', vi.fn(async () =>
  new Response(JSON.stringify({ user_id: '@caller:matrix.test', device_id: 'DEV' }), { status: 200 }),
))

import { GET } from './+server'

const ALL_ROOMS = ['!closed:matrix.test', '!open:matrix.test', '!mine:matrix.test']

function event(user: { id: string; roles: Role[] }) {
  return {
    locals: { user },
    request: new Request('http://localhost/api/auth/matrix-token', { headers: { Authorization: 'Bearer kc-jwt' } }),
    url: new URL('http://localhost/api/auth/matrix-token'),
  } as never
}

/** The backfill is fire-and-forget; let its promise chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
  h.unitRooms = { 'member-1': ['!mine:matrix.test'] }
  h.getMatrixToken.mockResolvedValue('matrix-token')
  h.getJoinedRooms.mockResolvedValue([])
  h.listAllRoomIds.mockResolvedValue(ALL_ROOMS)
  h.forceJoinRoom.mockResolvedValue(undefined)
  h.marker.mockResolvedValue(null)
})

describe('GET /api/auth/matrix-token first-login auto-join is scoped (H18)', () => {
  it('a Guest gets a token but is force-joined NOWHERE', async () => {
    const res = (await GET(event({ id: 'guest-1', roles: [Role.Guest] }))) as Response
    expect(res.status).toBe(200)
    await settle()
    expect(h.forceJoinRoom).not.toHaveBeenCalled()
  })

  it('a Member is joined only to the rooms of their own org units', async () => {
    const res = (await GET(event({ id: 'member-1', roles: [Role.Member] }))) as Response
    expect(res.status).toBe(200)
    await settle()
    expect(h.forceJoinRoom.mock.calls).toEqual([['!mine:matrix.test', '@caller:matrix.test']])
  })

  // Review advisory r2 (security, LOW): when whoami fails, the id is GUESSED
  // from preferredUsername; the Synapse admin force-join ignores join rules, so
  // a guessed id could put a different Matrix account into the caller's unit
  // rooms. Only a Synapse-confirmed id is ever force-joined.
  it('a failed whoami still returns a token but force-joins nobody', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('whoami down'))
    const res = (await GET(event({ id: 'member-1', roles: [Role.Member] }))) as Response
    expect(res.status).toBe(200)
    await settle()
    expect(h.forceJoinRoom).not.toHaveBeenCalled()
  })
})
