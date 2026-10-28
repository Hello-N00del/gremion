import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Role } from '$lib/auth/types'

const { mockCreateRoom, mockInviteUser, mockJoinRoom, mockResolveMatrixCreds, mockGetEvent, mockOrgUnits } = vi.hoisted(() => ({
  mockGetEvent: vi.fn(),
  mockOrgUnits: vi.fn(),
  mockCreateRoom: vi.fn(),
  mockInviteUser: vi.fn(),
  mockJoinRoom: vi.fn(),
  mockResolveMatrixCreds: vi.fn(),
}))

vi.mock('$lib/server/messages/matrix-client', () => ({
  getMatrixClient: () => ({
    createRoom: mockCreateRoom,
    inviteUser: mockInviteUser,
    joinRoom: mockJoinRoom,
  }),
}))

vi.mock('$lib/server/messages/matrix-creds', () => ({
  resolveMatrixCreds: mockResolveMatrixCreds,
}))

// The calendar event the room is for: the caller must be allowed to manage / take part in it.
vi.mock('$lib/server/calendar/backend/resolve', () => ({
  resolveCalendarBackendOr503: () => ({ getEvent: mockGetEvent }),
}))
vi.mock('$lib/server/governance/org-units-db', () => ({ getOrgUnitIdsForUser: mockOrgUnits }))

vi.mock('$env/dynamic/private', () => ({
  env: new Proxy({}, { get: () => 'sentinel' }),
}))

// Calendar event ids are UUIDs; the route validates that before any lookup.
const EVT = '0b7c6f1e-4a8e-4c51-9f3a-2d1e8c7b6a50'
const EVT9 = '1c8d7a2f-5b9f-4d62-8a4b-3e2f9d8c7b61'
const EVT_ALIAS = 'meeting-0b7c6f1e-4a8e-4c51-9f3a-2d1e8c7b6a50'

function makeEvent(opts: { authed: boolean; role?: Role; body?: unknown }) {
  const { authed, role = Role.Member, body } = opts
  const user = authed
    ? { id: 'u', roles: [role], groups: [], email: 'u@example.org', name: 'Test User', preferredUsername: 'u' }
    : null
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  return {
    locals: {
      user: undefined,
      auth: async () => (user ? { user, accessToken: 'kc_jwt', expires: '2099-01-01T00:00:00.000Z' } : null),
    },
    request: new Request('http://localhost/api/video/meeting-room', init),
    url: new URL('http://localhost/api/video/meeting-room'),
  }
}

let POST: (event: unknown) => Promise<Response>

beforeEach(async () => {
  vi.resetModules()
  mockCreateRoom.mockReset().mockResolvedValue('!room-meeting:matrix.test')
  // Default: the caller ('u') created the event, so they may open its room.
  mockGetEvent.mockReset().mockResolvedValue({ id: EVT, createdBy: 'u', committeeIds: [] })
  mockOrgUnits.mockReset().mockResolvedValue([])
  mockInviteUser.mockReset().mockResolvedValue(undefined)
  mockJoinRoom.mockReset().mockResolvedValue(undefined)
  mockResolveMatrixCreds
    .mockReset()
    .mockResolvedValue({ userId: '@test:matrix.test', accessToken: 'mx_token' })
  const mod = await import('./+server')
  POST = mod.POST as (event: unknown) => Promise<Response>
})

describe('POST /api/video/meeting-room', () => {
  it('creates/reuses the meeting room, makes the caller a member, and returns the roomId', async () => {
    const event = makeEvent({ authed: true, body: { eventId: EVT, title: 'Vorstandssitzung' } })
    const res = await POST(event)
    expect(res.status, await res.clone().text()).toBe(200)
    const data = await res.json()
    expect(data).toEqual({ success: true, roomId: '!room-meeting:matrix.test' })

    // Alias localpart is derived from the lowercased, slug-safe eventId.
    expect(mockCreateRoom).toHaveBeenCalledWith(
      'Vorstandssitzung',
      'Videobesprechung – Vorstandssitzung',
      EVT_ALIAS,
    )
    // Caller becomes a member before the call: admin invite, then user join.
    expect(mockInviteUser).toHaveBeenCalledWith('!room-meeting:matrix.test', '@test:matrix.test')
    expect(mockJoinRoom).toHaveBeenCalledWith('mx_token', '!room-meeting:matrix.test')
  })

  it('is idempotent: the same eventId reuses the same room (same alias localpart)', async () => {
    const body = { eventId: EVT, title: 'Vorstandssitzung' }
    const res1 = await POST(makeEvent({ authed: true, body }))
    const res2 = await POST(makeEvent({ authed: true, body }))
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
    expect((await res1.json()).roomId).toBe('!room-meeting:matrix.test')
    expect((await res2.json()).roomId).toBe('!room-meeting:matrix.test')
    // Both calls use the identical alias localpart → createRoom adopts the
    // existing room on the second call (idempotent by alias).
    expect(mockCreateRoom).toHaveBeenNthCalledWith(1, expect.anything(), expect.anything(), EVT_ALIAS)
    expect(mockCreateRoom).toHaveBeenNthCalledWith(2, expect.anything(), expect.anything(), EVT_ALIAS)
  })

  it('builds the alias from the calendar event id, so another spelling of the same uuid maps to the same room', async () => {
    await POST(makeEvent({ authed: true, body: { eventId: EVT.toUpperCase() } }))
    const aliasArg = (mockCreateRoom.mock.calls[0] as unknown[])[2]
    expect(aliasArg).toBe(EVT_ALIAS)
  })

  it('404s a non-uuid eventId without any calendar lookup or Matrix call', async () => {
    const res = await POST(makeEvent({ authed: true, body: { eventId: 'Foo Bar/#42!' } }))
    expect(res.status).toBe(404)
    expect(mockGetEvent).not.toHaveBeenCalled()
    expect(mockCreateRoom).not.toHaveBeenCalled()
  })

  it('answers 503 (not a silent 404) when the calendar lookup itself fails', async () => {
    mockGetEvent.mockRejectedValue(new Error('calendar leaf down'))
    const res = await POST(makeEvent({ authed: true, body: { eventId: EVT } }))
    expect(res.status).toBe(503)
    expect(mockCreateRoom).not.toHaveBeenCalled()
  })

  it('falls back to "Besprechung" when no title is supplied', async () => {
    await POST(makeEvent({ authed: true, body: { eventId: EVT } }))
    expect(mockCreateRoom).toHaveBeenCalledWith('Besprechung', `Videobesprechung – ${EVT}`, EVT_ALIAS)
  })

  it('returns 401 when unauthenticated and never touches Matrix', async () => {
    const res = await POST(makeEvent({ authed: false, body: { eventId: EVT } }))
    expect(res.status).toBe(401)
    expect(mockCreateRoom).not.toHaveBeenCalled()
  })

  it('returns 403 for a guest (below Member)', async () => {
    const res = await POST(makeEvent({ authed: true, role: Role.Guest, body: { eventId: EVT } }))
    expect(res.status).toBe(403)
    expect(mockCreateRoom).not.toHaveBeenCalled()
  })

  it('returns 400 when eventId is missing', async () => {
    const res = await POST(makeEvent({ authed: true, body: {} }))
    expect(res.status).toBe(400)
    expect(mockCreateRoom).not.toHaveBeenCalled()
  })

  it('returns 403 when the user has no Matrix credentials', async () => {
    mockResolveMatrixCreds.mockResolvedValueOnce({ userId: '', accessToken: '' })
    const res = await POST(makeEvent({ authed: true, body: { eventId: EVT } }))
    expect(res.status).toBe(403)
    expect(mockCreateRoom).not.toHaveBeenCalled()
  })

  it('returns 502 when Matrix room preparation fails', async () => {
    mockCreateRoom.mockRejectedValueOnce(new Error('synapse down'))
    const res = await POST(makeEvent({ authed: true, body: { eventId: EVT } }))
    expect(res.status).toBe(502)
  })

  describe('event authorisation', () => {
    it('404s (and never touches Matrix) when the event does not exist', async () => {
      mockGetEvent.mockResolvedValue(null)
      const res = await POST(makeEvent({ authed: true, body: { eventId: EVT } }))
      expect(res.status).toBe(404)
      expect(mockCreateRoom).not.toHaveBeenCalled()
      expect(mockInviteUser).not.toHaveBeenCalled()
    })

    it('404s an event of a committee the caller is not in (no invite, no join)', async () => {
      mockGetEvent.mockResolvedValue({ id: EVT9, createdBy: 'someone-else', committeeIds: ['c1'] })
      mockOrgUnits.mockResolvedValue(['c2'])
      const res = await POST(makeEvent({ authed: true, body: { eventId: EVT9 } }))
      expect(res.status).toBe(404)
      expect(mockCreateRoom).not.toHaveBeenCalled()
      expect(mockInviteUser).not.toHaveBeenCalled()
      expect(mockJoinRoom).not.toHaveBeenCalled()
    })

    it('allows a member of one of the event committees', async () => {
      mockGetEvent.mockResolvedValue({ id: EVT9, createdBy: 'someone-else', committeeIds: ['c1'] })
      mockOrgUnits.mockResolvedValue(['c1'])
      const res = await POST(makeEvent({ authed: true, body: { eventId: EVT9 } }))
      expect(res.status).toBe(200)
    })

    it('allows a CouncilAdmin', async () => {
      mockGetEvent.mockResolvedValue({ id: EVT9, createdBy: 'someone-else', committeeIds: ['c1'] })
      const res = await POST(makeEvent({ authed: true, role: Role.CouncilAdmin, body: { eventId: EVT9 } }))
      expect(res.status).toBe(200)
    })
  })
})
