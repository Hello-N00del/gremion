// FLOW-MSG-001 (TASK-009 lane B, rows-plan.md row 10): T18 — GET
// /api/messages/rooms marks an archived room `archived:true`, and the
// first-login auto-join backfill skips archived rooms.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth/types'

const { mockGetMatrixToken, mockGetJoinedRooms, mockUnread, mockListAllRoomIds, mockForceJoinRoom, mockMarker } =
  vi.hoisted(() => ({
    mockGetMatrixToken: vi.fn(),
    mockGetJoinedRooms: vi.fn(),
    mockUnread: vi.fn(),
    mockListAllRoomIds: vi.fn(),
    mockForceJoinRoom: vi.fn(),
    mockMarker: vi.fn(),
  }))

vi.mock('$lib/server/messages/backend', () => ({
  getMessagesBackend: () => ({
    matrix: () => ({
      getMatrixToken: mockGetMatrixToken,
      getJoinedRooms: mockGetJoinedRooms,
      unreadMessageCountsByRoom: mockUnread,
    }),
    synapse: () => ({ listAllRoomIds: mockListAllRoomIds, forceJoinRoom: mockForceJoinRoom }),
  }),
}))
vi.mock('$lib/server/tenant/context', () => ({
  getTenant: () => ({ id: 'default', slug: 'default' }),
}))
// The route's own m.room.name fetch uses global fetch directly (unrelated to
// the archived-marker read, which goes through room-admin — mocked below).
vi.stubGlobal('fetch', vi.fn(async () =>
  new Response(JSON.stringify({ name: 'Raum' }), { status: 200, headers: { 'content-type': 'application/json' } })
))
vi.mock('$lib/server/messages/admin/room-admin', () => ({
  getRoomArchiveMarker: mockMarker,
  createRoom: vi.fn(),
}))
// F1-FIX-04 (H18): the auto-join candidates are the rooms of the caller's own
// org units (provisioning ledger x org_unit_members), no longer every server
// room -- so the candidate list now comes from the kernel DB. The tests below
// feed their former listAllRoomIds fixture through that source instead.
const unitRoomState = vi.hoisted(() => ({ rooms: [] as string[] }))
vi.mock('$lib/server/db', () => ({
  getDb: () => (strings: TemplateStringsArray) =>
    Promise.resolve(
      strings.join('?').includes('provisioning_resources')
        ? unitRoomState.rooms.map((roomId) => ({ roomId }))
        : [],
    ),
}))

let GET: (event: unknown) => Promise<Response>

beforeEach(async () => {
  vi.clearAllMocks()
  mockGetMatrixToken.mockResolvedValue('matrix-token')
  mockUnread.mockResolvedValue(new Map())
  GET = (await import('./+server')).GET as (event: unknown) => Promise<Response>
})

const USER = { id: 'u', roles: [Role.Member], groups: [], email: 'u@example.org', name: 'u' }

function event() {
  return {
    locals: { user: USER, auth: async () => ({ user: USER, accessToken: 'kc-jwt' }) },
    params: {},
    request: new Request('http://localhost/api/messages/rooms', { headers: { 'content-type': 'application/json' } }),
    url: new URL('http://localhost/api/messages/rooms'),
  } as never
}

describe('T18: GET /api/messages/rooms — archived flag', () => {
  it('marks an archived room archived:true and an active room archived:false', async () => {
    mockGetJoinedRooms.mockResolvedValue(['!active:matrix.test', '!archived:matrix.test'])
    mockMarker.mockImplementation(async (roomId: string) =>
      roomId === '!archived:matrix.test' ? { org_unit_id: 'u1', archived_at: '2026-09-01T00:00:00Z' } : null
    )

    const res = await GET(event())
    expect(res.status, await res.clone().text()).toBe(200)
    const body = await res.json()
    const active = body.data.find((r: { roomId: string }) => r.roomId === '!active:matrix.test')
    const archived = body.data.find((r: { roomId: string }) => r.roomId === '!archived:matrix.test')
    expect(active.archived).toBe(false)
    expect(archived.archived).toBe(true)
  })
})

describe('getRoomArchiveMarker rejections: auto-join fails CLOSED, listing stays usable', () => {
  it('excludes a room from auto-join when its marker read REJECTS (transient failure)', async () => {
    mockGetJoinedRooms
      .mockResolvedValueOnce([]) // pre-auto-join: no joined rooms yet
      .mockResolvedValueOnce(['!ok:matrix.test']) // post-auto-join re-read
    unitRoomState.rooms = ['!ok:matrix.test', '!flaky:matrix.test']
    mockMarker.mockImplementation(async (roomId: string) => {
      if (roomId === '!flaky:matrix.test') throw new Error('ETIMEDOUT')
      return null
    })
    mockForceJoinRoom.mockResolvedValue(undefined)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes('/account/whoami')) {
        return new Response(JSON.stringify({ user_id: '@u:matrix.test' }), { status: 200 })
      }
      return new Response(JSON.stringify({ name: 'Raum' }), { status: 200 })
    })

    await GET(event())

    expect(mockForceJoinRoom).toHaveBeenCalledTimes(1)
    expect(mockForceJoinRoom).toHaveBeenCalledWith('!ok:matrix.test', '@u:matrix.test')
    expect(mockForceJoinRoom).not.toHaveBeenCalledWith('!flaky:matrix.test', expect.anything())
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('fail-closed'),
      expect.objectContaining({ roomId: '!flaky:matrix.test' })
    )
    errSpy.mockRestore()
  })

  // TASK-009 verifier FIX 1: the LISTING is display-only (the server-side
  // mutation guards re-read the marker themselves). Degrading a failed read to
  // archived:true hid the composer on every DM and user room during a Matrix
  // blip, so the listing now shows such a room as NOT archived — and logs the
  // failure so an elevated failure rate stays observable. Auto-join above
  // still fails CLOSED.
  it('lists a room whose marker read REJECTS as archived:false (composer kept) and logs the failure', async () => {
    mockGetJoinedRooms.mockResolvedValue(['!flaky:matrix.test'])
    mockMarker.mockRejectedValue(new Error('ETIMEDOUT'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await GET(event())
    expect(res.status, await res.clone().text()).toBe(200)
    const body = await res.json()
    expect(body.data[0].archived).toBe(false)
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('getRoomArchiveMarker failed while listing room'),
      expect.objectContaining({ roomId: '!flaky:matrix.test' })
    )
    errSpy.mockRestore()
  })
})

describe('T18: first-login auto-join skips archived rooms', () => {
  it('force-joins only the non-archived server rooms when the user has none yet', async () => {
    mockGetJoinedRooms
      .mockResolvedValueOnce([]) // pre-auto-join: no joined rooms yet
      .mockResolvedValueOnce(['!fresh:matrix.test']) // post-auto-join re-read
    unitRoomState.rooms = ['!fresh:matrix.test', '!archived:matrix.test']
    mockMarker.mockImplementation(async (roomId: string) =>
      roomId === '!archived:matrix.test' ? { org_unit_id: 'u1' } : null
    )
    mockForceJoinRoom.mockResolvedValue(undefined)
    // whoami — a second, distinct fetch call (unrelated to m.room.name/archived-marker mocks above).
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes('/account/whoami')) {
        return new Response(JSON.stringify({ user_id: '@u:matrix.test' }), { status: 200 })
      }
      return new Response(JSON.stringify({ name: 'Raum' }), { status: 200 })
    })

    await GET(event())

    expect(mockForceJoinRoom).toHaveBeenCalledTimes(1)
    expect(mockForceJoinRoom).toHaveBeenCalledWith('!fresh:matrix.test', '@u:matrix.test')
    expect(mockForceJoinRoom).not.toHaveBeenCalledWith('!archived:matrix.test', expect.anything())
  })
})
