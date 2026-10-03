import { describe, expect, it, vi, beforeEach } from 'vitest'

// #257-1 room-membership gate: the token route resolves the backend
// (getMessagesBackend → InprocessMessagesClient → getSynapseAdmin()) and calls
// synapse().isRoomMember before minting a room-pinned token. Mock getSynapseAdmin
// so each test controls the membership verdict; hoisted so the vi.mock factory can
// reference it. Default (set per-test in beforeEach) is member=true so the pre-gate
// room-call assertions still exercise the happy path.
const { isRoomMemberMock } = vi.hoisted(() => ({ isRoomMemberMock: vi.fn() }))

vi.mock('$lib/server/messages/synapse-admin', () => ({
  getSynapseAdmin: vi.fn(() => ({ isRoomMember: isRoomMemberMock })),
}))

vi.mock('$env/dynamic/private', () => ({
  env: {
    LIVEKIT_API_KEY: 'testkey',
    LIVEKIT_API_SECRET: 'testsecret-must-be-at-least-32-chars',
    MATRIX_URL: 'http://matrix.test',
  },
}))

vi.mock('$lib/server/messages/livekit-client', () => ({
  mintToken: vi.fn().mockResolvedValue('mock.jwt.token'),
  roomNameFromMatrixId: vi.fn((id: string) => `stura-room-${id.replace(/^!/, '').split(':')[0]}`),
  dmRoomName: vi.fn().mockReturnValue('stura-dm-abcdef1234567890'),
}))

vi.mock('$lib/server/messages/matrix-client', () => ({
  getMatrixClient: vi.fn(() => ({
    getMatrixToken: vi.fn().mockResolvedValue('mx_token'),
  })),
}))

const makeLocals = (role: string) => ({
  auth: async () => ({
    user: {
      name: 'Test User',
      email: 'test@example.com',
      roles: [role],
      groups: [],
      id: 'sub-1',
    },
    accessToken: 'kc_jwt',
  }),
  user: undefined,
})

const makeCookies = () => ({
  set: vi.fn(),
  get: vi.fn(),
  getAll: vi.fn().mockReturnValue([]),
  delete: vi.fn(),
  serialize: vi.fn(),
})

const makeRequest = (body: Record<string, unknown>) =>
  new Request('http://localhost/api/video/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /api/video/token', () => {
  beforeEach(() => {
    vi.resetModules()
    // Default: caller IS a member — keeps the pre-existing room-call assertions on
    // their happy path. The membership-gate tests below override per-case.
    isRoomMemberMock.mockReset().mockResolvedValue(true)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ user_id: '@test:matrix.test' }),
      }),
    )
  })

  it('returns 403 when unauthenticated', async () => {
    const { POST } = await import('./+server')
    const res = await POST({
      request: makeRequest({ roomType: 'room', matrixRoomId: '!abc:test' }),
      locals: { auth: async () => null, user: undefined },
      cookies: makeCookies(),
    } as unknown as Parameters<typeof POST>[0])
    expect(res.status).toBe(403)
  })

  it('returns token for member starting a room call (canPublish=true)', async () => {
    const { POST } = await import('./+server')
    const { mintToken } = await import('$lib/server/messages/livekit-client')
    const res = await POST({
      request: makeRequest({ roomType: 'room', matrixRoomId: '!abc123:matrix.test' }),
      locals: makeLocals('member'),
      cookies: makeCookies(),
    } as unknown as Parameters<typeof POST>[0])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.token).toBe('mock.jwt.token')
    expect(mintToken).toHaveBeenCalledWith(expect.objectContaining({ canPublish: true }))
  })

  it('returns subscribe-only token for guest joining a room call (canPublish=false)', async () => {
    const { POST } = await import('./+server')
    const { mintToken } = await import('$lib/server/messages/livekit-client')
    const res = await POST({
      request: makeRequest({ roomType: 'room', matrixRoomId: '!abc123:matrix.test' }),
      locals: makeLocals('guest'),
      cookies: makeCookies(),
    } as unknown as Parameters<typeof POST>[0])
    expect(res.status).toBe(200)
    expect(mintToken).toHaveBeenCalledWith(expect.objectContaining({ canPublish: false }))
  })

  // #257-1 room-membership gate: a non-member is denied a room-pinned token.
  it('returns 403 for a room call when the caller is not a room member', async () => {
    isRoomMemberMock.mockResolvedValue(false)
    const { POST } = await import('./+server')
    const res = await POST({
      request: makeRequest({ roomType: 'room', matrixRoomId: '!abc123:matrix.test' }),
      locals: makeLocals('member'),
      cookies: makeCookies(),
    } as unknown as Parameters<typeof POST>[0])
    // 403 (not 200) is itself the proof no token was minted — the route returns
    // before reaching lk.mintToken.
    expect(res.status).toBe(403)
    expect(isRoomMemberMock).toHaveBeenCalledWith('!abc123:matrix.test', '@test:matrix.test')
    const errBody = await res.json()
    expect(errBody.success).toBe(false)
  })

  // #257-1 room-membership gate: a confirmed member gets the token.
  it('returns 200 for a room call when the caller is a confirmed room member', async () => {
    isRoomMemberMock.mockResolvedValue(true)
    const { POST } = await import('./+server')
    const { mintToken } = await import('$lib/server/messages/livekit-client')
    const res = await POST({
      request: makeRequest({ roomType: 'room', matrixRoomId: '!abc123:matrix.test' }),
      locals: makeLocals('member'),
      cookies: makeCookies(),
    } as unknown as Parameters<typeof POST>[0])
    expect(res.status).toBe(200)
    expect(isRoomMemberMock).toHaveBeenCalledWith('!abc123:matrix.test', '@test:matrix.test')
    expect(mintToken).toHaveBeenCalledWith(expect.objectContaining({ canPublish: true }))
  })

  it('returns full token for guest initiating a DM call (canPublish=true)', async () => {
    const { POST } = await import('./+server')
    const { mintToken } = await import('$lib/server/messages/livekit-client')
    const res = await POST({
      request: makeRequest({ roomType: 'dm', peerMatrixId: '@peer:matrix.test' }),
      locals: makeLocals('guest'),
      cookies: makeCookies(),
    } as unknown as Parameters<typeof POST>[0])
    expect(res.status).toBe(200)
    expect(mintToken).toHaveBeenCalledWith(expect.objectContaining({ canPublish: true }))
  })

  it('returns 400 for unknown roomType', async () => {
    const { POST } = await import('./+server')
    const res = await POST({
      request: makeRequest({ roomType: 'unknown' }),
      locals: makeLocals('member'),
      cookies: makeCookies(),
    } as unknown as Parameters<typeof POST>[0])
    expect(res.status).toBe(400)
  })

  // G-022: matrix access token must never appear in JSON body
  it('G-022: response body never contains matrixAccessToken', async () => {
    const { POST } = await import('./+server')
    const res = await POST({
      request: makeRequest({ roomType: 'room', matrixRoomId: '!abc123:matrix.test' }),
      locals: makeLocals('member'),
      cookies: makeCookies(),
    } as unknown as Parameters<typeof POST>[0])
    const body = await res.json()
    expect(body).not.toHaveProperty('matrixAccessToken')
  })

  // G-022: matrix access token is set as HttpOnly cookie with all four flags
  it('G-022: matrix access token is set on /matrix scoped HttpOnly Secure SameSite=strict cookie', async () => {
    const { POST } = await import('./+server')
    const cookies = makeCookies()
    const res = await POST({
      request: makeRequest({ roomType: 'room', matrixRoomId: '!abc123:matrix.test' }),
      locals: makeLocals('member'),
      cookies,
    } as unknown as Parameters<typeof POST>[0])
    expect(res.status).toBe(200)
    expect(cookies.set).toHaveBeenCalledWith(
      'matrix_access',
      'mx_token',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/matrix',
        maxAge: 3600,
      }),
    )
  })

  // G-022: do NOT set the cookie when matrix creds resolution fails (empty token)
  it('G-022: does not set matrix_access cookie when matrix creds resolution fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) }),
    )
    const { POST } = await import('./+server')
    const cookies = makeCookies()
    await POST({
      request: makeRequest({ roomType: 'room', matrixRoomId: '!abc123:matrix.test' }),
      locals: makeLocals('member'),
      cookies,
    } as unknown as Parameters<typeof POST>[0])
    expect(cookies.set).not.toHaveBeenCalled()
  })
})
