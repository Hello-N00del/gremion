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
  mockGetEvent.mockReset().mockResolvedValue({ id: 'EVT-42', createdBy: 'u', committeeIds: [] })
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
    const event = makeEvent({ authed: true, body: { eventId: 'EVT-42', title: 'Vorstandssitzung' } })
    const res = await POST(event)
    expect(res.status, await res.clone().text()).toBe(200)
    const data = await res.json()
    expect(data).toEqual({ success: true, roomId: '!room-meeting:matrix.test' })

    // Alias localpart is derived from the lowercased, slug-safe eventId.
    expect(mockCreateRoom).toHaveBeenCalledWith(
      'Vorstandssitzung',
      'Videobesprechung – Vorstandssitzung',
      'meeting-evt-42',
    )
    // Caller becomes a member before the call: admin invite, then user join.
    expect(mockInviteUser).toHaveBeenCalledWith('!room-meeting:matrix.test', '@test:matrix.test')
    expect(mockJoinRoom).toHaveBeenCalledWith('mx_token', '!room-meeting:matrix.test')
  })

  it('is idempotent: the same eventId reuses the same room (same alias localpart)', async () => {
    const body = { eventId: 'EVT-42', title: 'Vorstandssitzung' }
    const res1 = await POST(makeEvent({ authed: true, body }))
    const res2 = await POST(makeEvent({ authed: true, body }))
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
    expect((await res1.json()).roomId).toBe('!room-meeting:matrix.test')
    expect((await res2.json()).roomId).toBe('!room-meeting:matrix.test')
    // Both calls use the identical alias localpart → createRoom adopts the
    // existing room on the second call (idempotent by alias).
    expect(mockCreateRoom).toHaveBeenNthCalledWith(1, expect.anything(), expect.anything(), 'meeting-evt-42')
    expect(mockCreateRoom).toHaveBeenNthCalledWith(2, expect.anything(), expect.anything(), 'meeting-evt-42')
  })

  it('sanitises the eventId into the alias localpart', async () => {
    await POST(makeEvent({ authed: true, body: { eventId: 'Foo Bar/#42!' } }))
    const aliasArg = (mockCreateRoom.mock.calls[0] as unknown[])[2]
    expect(aliasArg).toBe('meeting-foo-bar--42-')
  })

  it('falls back to "Besprechung" when no title is supplied', async () => {
    await POST(makeEvent({ authed: true, body: { eventId: 'EVT-7' } }))
    expect(mockCreateRoom).toHaveBeenCalledWith('Besprechung', 'Videobesprechung – EVT-7', 'meeting-evt-7')
  })

  it('returns 401 when unauthenticated and never touches Matrix', async () => {
    const res = await POST(makeEvent({ authed: false, body: { eventId: 'EVT-1' } }))
    expect(res.status).toBe(401)
    expect(mockCreateRoom).not.toHaveBeenCalled()
  })

  it('returns 403 for a guest (below Member)', async () => {
    const res = await POST(makeEvent({ authed: true, role: Role.Guest, body: { eventId: 'EVT-1' } }))
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
    const res = await POST(makeEvent({ authed: true, body: { eventId: 'EVT-1' } }))
    expect(res.status).toBe(403)
    expect(mockCreateRoom).not.toHaveBeenCalled()
  })

  it('returns 502 when Matrix room preparation fails', async () => {
    mockCreateRoom.mockRejectedValueOnce(new Error('synapse down'))
    const res = await POST(makeEvent({ authed: true, body: { eventId: 'EVT-1' } }))
    expect(res.status).toBe(502)
  })

  describe('event authorisation', () => {
    it('404s (and never touches Matrix) when the event does not exist', async () => {
      mockGetEvent.mockResolvedValue(null)
      const res = await POST(makeEvent({ authed: true, body: { eventId: 'EVT-404' } }))
      expect(res.status).toBe(404)
      expect(mockCreateRoom).not.toHaveBeenCalled()
      expect(mockInviteUser).not.toHaveBeenCalled()
    })

    it('404s an event of a committee the caller is not in (no invite, no join)', async () => {
      mockGetEvent.mockResolvedValue({ id: 'EVT-9', createdBy: 'someone-else', committeeIds: ['c1'] })
      mockOrgUnits.mockResolvedValue(['c2'])
      const res = await POST(makeEvent({ authed: true, body: { eventId: 'EVT-9' } }))
      expect(res.status).toBe(404)
      expect(mockCreateRoom).not.toHaveBeenCalled()
      expect(mockInviteUser).not.toHaveBeenCalled()
      expect(mockJoinRoom).not.toHaveBeenCalled()
    })

    it('allows a member of one of the event committees', async () => {
      mockGetEvent.mockResolvedValue({ id: 'EVT-9', createdBy: 'someone-else', committeeIds: ['c1'] })
      mockOrgUnits.mockResolvedValue(['c1'])
      const res = await POST(makeEvent({ authed: true, body: { eventId: 'EVT-9' } }))
      expect(res.status).toBe(200)
    })

    it('allows a CouncilAdmin', async () => {
      mockGetEvent.mockResolvedValue({ id: 'EVT-9', createdBy: 'someone-else', committeeIds: ['c1'] })
      const res = await POST(makeEvent({ authed: true, role: Role.CouncilAdmin, body: { eventId: 'EVT-9' } }))
      expect(res.status).toBe(200)
    })
  })
})
