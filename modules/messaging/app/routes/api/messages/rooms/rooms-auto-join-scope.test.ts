// F1-FIX-04 (H18 / S3#25, S3#11, S1c#18; operator decision D-3): the
// first-login backfill in GET /api/messages/rooms force-joined ANY signed-in
// user with zero joined rooms -- Guests included -- into EVERY room on the
// homeserver through the Synapse admin join API, which ignores join rules. That
// put Guests and strangers into committee_only unit rooms.
// Now: a Guest is never auto-joined; a Member is joined only to the Matrix
// rooms of the org units they belong to (provisioning ledger, org_unit_members).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth/types'

const h = vi.hoisted(() => ({
  getMatrixToken: vi.fn(),
  getJoinedRooms: vi.fn(),
  unread: vi.fn(),
  listAllRoomIds: vi.fn(),
  forceJoinRoom: vi.fn(),
  marker: vi.fn(),
  // user keycloak id -> Matrix room ids of the units that user belongs to
  unitRooms: {} as Record<string, string[]>,
}))

vi.mock('$lib/server/messages/backend', () => ({
  getMessagesBackend: () => ({
    matrix: () => ({
      getMatrixToken: h.getMatrixToken,
      getJoinedRooms: h.getJoinedRooms,
      unreadMessageCountsByRoom: h.unread,
    }),
    synapse: () => ({ listAllRoomIds: h.listAllRoomIds, forceJoinRoom: h.forceJoinRoom }),
  }),
}))
vi.mock('$lib/server/tenant/context', () => ({
  getTenant: () => ({ id: 'default', slug: 'default' }),
}))
vi.mock('$lib/server/messages/admin/room-admin', () => ({
  getRoomArchiveMarker: h.marker,
  createRoom: vi.fn(),
}))
// The unit-room source is the kernel DB (provisioning ledger x org_unit_members).
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

vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  if (String(url).includes('/account/whoami')) {
    return new Response(JSON.stringify({ user_id: '@caller:matrix.test' }), { status: 200 })
  }
  return new Response(JSON.stringify({ name: 'Raum' }), { status: 200 })
}))

const ALL_ROOMS = ['!closed:matrix.test', '!open:matrix.test', '!mine:matrix.test']

let GET: (event: unknown) => Promise<Response>

beforeEach(async () => {
  vi.clearAllMocks()
  h.unitRooms = { 'member-1': ['!mine:matrix.test'] }
  h.getMatrixToken.mockResolvedValue('matrix-token')
  h.getJoinedRooms.mockResolvedValue([])
  h.unread.mockResolvedValue(new Map())
  h.listAllRoomIds.mockResolvedValue(ALL_ROOMS)
  h.forceJoinRoom.mockResolvedValue(undefined)
  h.marker.mockResolvedValue(null)
  GET = (await import('./+server')).GET as (event: unknown) => Promise<Response>
})

function event(user: { id: string; roles: Role[] }) {
  return {
    locals: { user, auth: async () => ({ user, accessToken: 'kc-jwt' }) },
    params: {},
    request: new Request('http://localhost/api/messages/rooms'),
    url: new URL('http://localhost/api/messages/rooms'),
  } as never
}

describe('GET /api/messages/rooms first-login auto-join is scoped (H18)', () => {
  it('a Guest with zero joined rooms triggers NO forceJoinRoom', async () => {
    const res = await GET(event({ id: 'guest-1', roles: [Role.Guest] }))
    expect(res.status).toBe(200)
    expect(h.forceJoinRoom).not.toHaveBeenCalled()
  })

  it('a Member is joined only to the rooms of their own org units', async () => {
    await GET(event({ id: 'member-1', roles: [Role.Member] }))
    expect(h.forceJoinRoom.mock.calls).toEqual([['!mine:matrix.test', '@caller:matrix.test']])
  })

  it('a Member of no unit is joined nowhere', async () => {
    await GET(event({ id: 'member-2', roles: [Role.Member] }))
    expect(h.forceJoinRoom).not.toHaveBeenCalled()
  })

  it('an archived unit room is still skipped (fail closed on a marker read error)', async () => {
    h.unitRooms = { 'member-1': ['!mine:matrix.test', '!old:matrix.test', '!flaky:matrix.test'] }
    h.marker.mockImplementation(async (roomId: string) => {
      if (roomId === '!old:matrix.test') return { org_unit_id: 'u1' }
      if (roomId === '!flaky:matrix.test') throw new Error('ETIMEDOUT')
      return null
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await GET(event({ id: 'member-1', roles: [Role.Member] }))
    expect(h.forceJoinRoom.mock.calls).toEqual([['!mine:matrix.test', '@caller:matrix.test']])
    errSpy.mockRestore()
  })
})
