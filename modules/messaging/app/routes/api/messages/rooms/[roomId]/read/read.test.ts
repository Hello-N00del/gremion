import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Role } from '$lib/auth/types'

const { mockGetMatrixToken, mockSetReadMarker, mockGetMessages } = vi.hoisted(() => ({
  mockGetMatrixToken: vi.fn(),
  mockSetReadMarker: vi.fn(),
  mockGetMessages: vi.fn(),
}))

vi.mock('$lib/server/messages/matrix-client', () => ({
  getMatrixClient: () => ({
    getMatrixToken: mockGetMatrixToken,
    setReadMarker: mockSetReadMarker,
    getMessages: mockGetMessages,
  }),
}))

vi.mock('$env/dynamic/private', () => ({
  env: new Proxy({}, { get: () => 'sentinel' }),
}))

function makeEvent(opts: {
  authed: boolean
  accessToken?: string
  roomId?: string
  body?: unknown
}) {
  const { authed, accessToken = 'kc-jwt', roomId = '!room1:matrix.test', body } = opts
  const user = authed
    ? { id: 'u', roles: [Role.Member], groups: [], email: 'u@example.org', name: 'u', preferredUsername: 'u' }
    : null
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  return {
    locals: {
      user,
      auth: async () => (user ? { user, accessToken, expires: '2099-01-01T00:00:00.000Z' } : null),
    },
    params: { roomId },
    request: new Request('http://localhost/api/messages/rooms/r/read', init),
    url: new URL('http://localhost/api/messages/rooms/r/read'),
  }
}

let POST: (event: unknown) => Promise<Response>

beforeEach(async () => {
  mockGetMatrixToken.mockReset().mockResolvedValue('matrix-token')
  mockSetReadMarker.mockReset().mockResolvedValue(undefined)
  mockGetMessages.mockReset().mockResolvedValue({ messages: [], end: '' })
  const mod = await import('./+server')
  POST = mod.POST as (event: unknown) => Promise<Response>
})

describe('POST /api/messages/rooms/[roomId]/read', () => {
  it('marks the room read via setReadMarker and returns 200 when an eventId is supplied', async () => {
    const event = makeEvent({ authed: true, body: { eventId: '$evt-1:matrix.test' } })
    const res = await POST(event)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(mockSetReadMarker).toHaveBeenCalledWith('matrix-token', '!room1:matrix.test', '$evt-1:matrix.test')
    // It should NOT need to resolve the latest event when the client supplied one.
    expect(mockGetMessages).not.toHaveBeenCalled()
  })

  it('resolves the latest event when no eventId is supplied, then marks it read', async () => {
    mockGetMessages.mockResolvedValueOnce({
      messages: [{ eventId: '$latest:matrix.test', sender: '@a:m', senderDisplayName: '@a:m', type: 'm.text', body: 'hi', ts: 1 }],
      end: 'tok',
    })
    const event = makeEvent({ authed: true, body: {} })
    const res = await POST(event)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(mockGetMessages).toHaveBeenCalledWith('matrix-token', '!room1:matrix.test')
    expect(mockSetReadMarker).toHaveBeenCalledWith('matrix-token', '!room1:matrix.test', '$latest:matrix.test')
  })

  it('returns 200 without calling setReadMarker when the room has no messages', async () => {
    const event = makeEvent({ authed: true, body: {} })
    const res = await POST(event)
    expect(res.status).toBe(200)
    expect(mockSetReadMarker).not.toHaveBeenCalled()
  })

  it('returns 401 for an unauthenticated request and never touches Matrix', async () => {
    const event = makeEvent({ authed: false, body: { eventId: '$evt:matrix.test' } })
    try {
      const res = await POST(event)
      expect(res.status).toBe(401)
    } catch (err) {
      expect((err as { status?: number }).status).toBe(401)
    }
    expect(mockGetMatrixToken).not.toHaveBeenCalled()
    expect(mockSetReadMarker).not.toHaveBeenCalled()
  })
})
