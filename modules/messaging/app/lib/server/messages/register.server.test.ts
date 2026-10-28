// Design v11 review: the 'messages:unread-rooms' data provider (D11 notification
// popover chat rows) must read each room's display name through the TENANT-KEYED
// MatrixClient (getRoomName), never via a hand-built serviceEnv('MATRIX_URL')
// URL — that would transmit a non-default tenant's per-user Matrix token to the
// DEFAULT tenant's homeserver (cross-tenant credential disclosure). The global
// fetch spy below is the regression pin: the provider itself must not fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetMatrixToken, mockSync, mockGetRoomName } = vi.hoisted(() => ({
  mockGetMatrixToken: vi.fn(),
  mockSync: vi.fn(),
  mockGetRoomName: vi.fn(),
}))

vi.mock('$env/dynamic/private', () => ({
  env: { MATRIX_URL: 'http://default-env:8008', SYNAPSE_SERVER_NAME: 'matrix.test' },
}))
vi.mock('./matrix-client', () => ({
  getMatrixClient: () => ({
    getMatrixToken: mockGetMatrixToken,
    sync: mockSync,
    getRoomName: mockGetRoomName,
  }),
  evictMatrixClient: vi.fn(),
}))
vi.mock('./synapse-admin', () => ({ getSynapseAdmin: vi.fn(), evictSynapseAdmin: vi.fn() }))
vi.mock('./livekit-client', () => ({ evictLivekitSettings: vi.fn() }))
vi.mock('./backend/service-client', () => ({ evictServiceMatrixTokenCache: vi.fn() }))
vi.mock('./provisioning/matrix-subsystem', () => ({ createMatrixSubsystem: vi.fn() }))

import { getDataProvider, getErasureHook } from '$lib/server/modules/runtime-registry'
// Side-effect import: registers the messages module's providers/hooks.
import './register.server'

describe("messages:unread-rooms provider (D11 popover) — design v11 review", () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockGetMatrixToken.mockReset().mockResolvedValue('mx-user-token')
    mockSync.mockReset().mockResolvedValue({
      nextBatch: 'b1',
      rooms: [
        { roomId: '!a:hs', events: [{ ts: 111 }, { ts: 222 }], unreadCount: 2 },
        { roomId: '!b:hs', events: [], unreadCount: 1 },
        { roomId: '!c:hs', events: [], unreadCount: 0 },
      ],
    })
    mockGetRoomName
      .mockReset()
      .mockImplementation(async (_token: string, roomId: string) =>
        roomId === '!a:hs' ? 'Vorstand' : null,
      )
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('resolves room names through the tenant client (getRoomName) — NEVER a hand-built fetch', async () => {
    const provider = getDataProvider('messages:unread-rooms')
    expect(provider).toBeDefined()

    const rows = await provider!('kc-jwt')

    expect(rows).toEqual([
      { roomId: '!a:hs', name: 'Vorstand', unread: 2, lastTs: 222 },
      // getRoomName → null degrades to the room id as display name.
      { roomId: '!b:hs', name: '!b:hs', unread: 1, lastTs: null },
    ])
    expect(mockGetRoomName).toHaveBeenCalledWith('mx-user-token', '!a:hs')
    expect(mockGetRoomName).toHaveBeenCalledWith('mx-user-token', '!b:hs')
    // The credential-disclosure pin: no hand-built homeserver URL — the provider
    // performs NO direct fetch (all Matrix I/O goes through the tenant client).
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns [] without an access token', async () => {
    const rows = await getDataProvider('messages:unread-rooms')!(null)
    expect(rows).toEqual([])
    expect(mockSync).not.toHaveBeenCalled()
  })

  it('degrades to [] on a Matrix error (sync throws)', async () => {
    mockSync.mockRejectedValueOnce(new Error('boom'))
    const rows = await getDataProvider('messages:unread-rooms')!('kc-jwt')
    expect(rows).toEqual([])
  })
})

describe('messaging erasure hook registration (TRD-196)', () => {
  it('registers the messaging erasure hook under its module id', async () => {
    const { messagingErasureHook } = await import('./erasure')
    expect(getErasureHook('messaging')).toBe(messagingErasureHook)
  })
})
