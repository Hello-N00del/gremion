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

// The cache key carries the tenant id. The provider runs inside the request's tenant scope in
// production; here the scope is a settable ref (null = no scope, which makes the real
// currentTenantId throw).
const tenantIdRef = vi.hoisted(() => ({ value: 'tenant-a' as string | null }))
vi.mock('$lib/server/tenant/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/tenant/context')>()),
  currentTenantId: () => {
    if (tenantIdRef.value === null) throw new Error('no tenant scope')
    return tenantIdRef.value
  },
}))

import { getDataProvider, getErasureHook } from '$lib/server/modules/runtime-registry'
import {
  clearAllUnreadCache,
  forgetUnread,
  unreadCacheSize,
  UNREAD_CACHE_MAX,
} from './unread-cache'
import { karenzParticipantsFor } from '$lib/server/module-karenz/participants'
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

// Every page navigation re-runs the root layout load, which awaited a full Matrix /sync for the
// unread badge each time. The count is cached per user for a short time, so a click does not
// queue behind the homeserver. Failures are never cached: a hiccup must not pin the badge to 0.
function jwtFor(sub: string): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'none' })}.${enc({ sub })}.sig`
}

describe('messages:unread-count provider cache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    tenantIdRef.value = 'tenant-a'
    mockGetMatrixToken.mockReset().mockResolvedValue('mx-user-token')
    mockSync.mockReset().mockResolvedValue({
      nextBatch: 'b1',
      rooms: [
        { roomId: '!a:hs', events: [], unreadCount: 2 },
        { roomId: '!b:hs', events: [], unreadCount: 3 },
      ],
    })
    clearAllUnreadCache()
  })

  afterEach(() => vi.useRealTimers())

  it('answers the second call of the same user from the cache, without another sync', async () => {
    const provider = getDataProvider('messages:unread-count')!
    expect(await provider(jwtFor('user-1'))).toBe(5)
    expect(await provider(jwtFor('user-1'))).toBe(5)
    expect(mockSync).toHaveBeenCalledTimes(1)
  })

  it('does not hand one user the count of another user, or of the same sub in another tenant', async () => {
    const provider = getDataProvider('messages:unread-count')!
    await provider(jwtFor('user-1'))
    mockSync.mockResolvedValueOnce({ nextBatch: 'b2', rooms: [{ roomId: '!x:hs', events: [], unreadCount: 7 }] })
    expect(await provider(jwtFor('user-2'))).toBe(7)
    mockSync.mockResolvedValueOnce({ nextBatch: 'b3', rooms: [{ roomId: '!y:hs', events: [], unreadCount: 1 }] })
    tenantIdRef.value = 'tenant-b'
    expect(await provider(jwtFor('user-1'))).toBe(1)
    expect(mockSync).toHaveBeenCalledTimes(3)
  })

  it('syncs again once the 20 s lifetime is over', async () => {
    const provider = getDataProvider('messages:unread-count')!
    await provider(jwtFor('user-1'))
    vi.setSystemTime(new Date('2026-01-01T00:00:19Z'))
    await provider(jwtFor('user-1'))
    expect(mockSync).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date('2026-01-01T00:00:21Z'))
    mockSync.mockResolvedValueOnce({ nextBatch: 'b2', rooms: [{ roomId: '!a:hs', events: [], unreadCount: 9 }] })
    expect(await provider(jwtFor('user-1'))).toBe(9)
    expect(mockSync).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failure: the next call syncs again and sees the real count', async () => {
    const provider = getDataProvider('messages:unread-count')!
    mockSync.mockRejectedValueOnce(new Error('homeserver down'))
    expect(await provider(jwtFor('user-1'))).toBe(0)
    expect(await provider(jwtFor('user-1'))).toBe(5)
    expect(mockSync).toHaveBeenCalledTimes(2)
  })

  it('does not cache a sync whose unread counts were degraded (the /notifications read failed)', async () => {
    const provider = getDataProvider('messages:unread-count')!
    mockSync.mockResolvedValueOnce({ nextBatch: 'b1', rooms: [{ roomId: '!a:hs', events: [], unreadCount: 0 }], countsDegraded: true })
    expect(await provider(jwtFor('user-1'))).toBe(0)
    expect(await provider(jwtFor('user-1'))).toBe(5)
    expect(mockSync).toHaveBeenCalledTimes(2)
  })

  it('does not store a count that was computed before forgetUnread ran while the sync was in flight', async () => {
    const provider = getDataProvider('messages:unread-count')!
    let finish!: (v: unknown) => void
    mockSync.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const inFlight = provider(jwtFor('user-1'))
    await vi.advanceTimersByTimeAsync(0)
    // The user marks a room read while the sync is still running.
    forgetUnread(jwtFor('user-1'))
    finish({ nextBatch: 'b1', rooms: [{ roomId: '!a:hs', events: [], unreadCount: 9 }] })
    expect(await inFlight).toBe(9)
    // The stale 9 must not be served from the cache: the next call asks again.
    expect(await provider(jwtFor('user-1'))).toBe(5)
    expect(mockSync).toHaveBeenCalledTimes(2)
  })

  it('forgetUnread drops the user entry, so a read room refreshes the badge at once', async () => {
    const provider = getDataProvider('messages:unread-count')!
    await provider(jwtFor('user-1'))
    forgetUnread(jwtFor('user-1'))
    mockSync.mockResolvedValueOnce({ nextBatch: 'b2', rooms: [] })
    expect(await provider(jwtFor('user-1'))).toBe(0)
    expect(mockSync).toHaveBeenCalledTimes(2)
  })

  it('stays bounded: many distinct users never grow the cache past its cap', async () => {
    const provider = getDataProvider('messages:unread-count')!
    for (let i = 0; i < UNREAD_CACHE_MAX + 50; i++) await provider(jwtFor(`user-${i}`))
    expect(unreadCacheSize()).toBeLessThanOrEqual(UNREAD_CACHE_MAX)
  })

  it('skips the cache without a tenant scope or a token subject, and still answers', async () => {
    const provider = getDataProvider('messages:unread-count')!
    tenantIdRef.value = null
    expect(await provider(jwtFor('user-1'))).toBe(5)
    expect(await provider(jwtFor('user-1'))).toBe(5)
    expect(mockSync).toHaveBeenCalledTimes(2)
    tenantIdRef.value = 'tenant-a'
    expect(await provider('not-a-jwt')).toBe(5)
    expect(await provider('not-a-jwt')).toBe(5)
    expect(mockSync).toHaveBeenCalledTimes(4)
  })
})

describe('messaging erasure hook registration (TRD-196)', () => {
  it('registers the messaging erasure hook under its module id', async () => {
    const { messagingErasureHook } = await import('./erasure')
    expect(getErasureHook('messaging')).toBe(messagingErasureHook)
  })
})

describe('messaging Karenz participant registration (Module Karenz, Task 15)', () => {
  it('registers the messaging participant under the messaging catalogue id', async () => {
    const { messagingKarenz } = await import('./karenz')
    expect(karenzParticipantsFor('messaging')).toEqual([messagingKarenz])
  })

  it('declares that messaging seals no retained records (otherwise its retained step fails closed and day 30 never finalizes)', async () => {
    const { hasRetentionDeclaration, extractorsFor } = await import('$lib/server/module-karenz/retained/extractors')
    expect(hasRetentionDeclaration('messaging')).toBe(true)
    expect(extractorsFor('messaging')).toEqual([])
  })
})
