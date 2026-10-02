import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// matrix-client reads MATRIX_URL / SYNAPSE_ADMIN_TOKEN / SYNAPSE_ADMIN_BOT_USER_ID
// at construction via $env/dynamic/private. Provide deterministic values so the
// constructed base URL is predictable.
vi.mock('$env/dynamic/private', () => ({
  env: {
    MATRIX_URL: 'http://matrix.test:8008',
    SYNAPSE_ADMIN_TOKEN: 'admin-token',
    SYNAPSE_ADMIN_BOT_USER_ID: '@bot:matrix.test',
  },
}))

// P2.1b T7 — getMatrixClient() is tenant-keyed (fail-closed). These tests
// exercise client METHOD behaviour, so pin a default-tenant scope.
vi.mock('$lib/server/tenant/context', () => ({
  getTenant: () => ({ id: 'default', slug: 'default' }),
  currentTenantId: () => 'default',
}))

describe('MatrixClient.setReadMarker', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // Synapse returns 200 with `{}` for read_markers.
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs m.read + m.fully_read to the room read_markers endpoint with the user token', async () => {
    const { getMatrixClient } = await import('./matrix-client')
    const mc = getMatrixClient()

    await mc.setReadMarker('user-token-xyz', '!room42:matrix.test', '$event-abc:matrix.test')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]

    // URL: base + client-server v3 read_markers, roomId URL-encoded.
    expect(url).toBe(
      'http://matrix.test:8008/_matrix/client/v3/rooms/' +
        encodeURIComponent('!room42:matrix.test') +
        '/read_markers'
    )
    // Method.
    expect(init.method).toBe('POST')
    // Auth header carries the user's Matrix token (not the admin token).
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer user-token-xyz')
    // Body sets both markers to the event id.
    expect(JSON.parse(init.body as string)).toEqual({
      'm.fully_read': '$event-abc:matrix.test',
      'm.read': '$event-abc:matrix.test',
    })
  })

  it('throws when Synapse rejects the read marker', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    )
    const { getMatrixClient } = await import('./matrix-client')
    const mc = getMatrixClient()

    await expect(
      mc.setReadMarker('user-token-xyz', '!room42:matrix.test', '$evt:matrix.test')
    ).rejects.toThrow(/403/)
  })
})

describe('MatrixClient.inviteUser', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // Synapse returns 200 with `{}` for a successful invite.
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs {user_id} to the room invite endpoint with the admin token', async () => {
    const { getMatrixClient } = await import('./matrix-client')
    const mc = getMatrixClient()

    await mc.inviteUser('!room42:matrix.test', '@alice:matrix.test')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]

    expect(url).toBe(
      'http://matrix.test:8008/_matrix/client/v3/rooms/' +
        encodeURIComponent('!room42:matrix.test') +
        '/invite'
    )
    expect(init.method).toBe('POST')
    // Invite uses the ADMIN token (not a user token).
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer admin-token')
    expect(JSON.parse(init.body as string)).toEqual({ user_id: '@alice:matrix.test' })
  })

  it('swallows the M_FORBIDDEN "already in the room" error (idempotent)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ errcode: 'M_FORBIDDEN', error: '@alice:matrix.test is already in the room.' }),
        { status: 403, headers: { 'content-type': 'application/json' } }
      )
    )
    const { getMatrixClient } = await import('./matrix-client')
    const mc = getMatrixClient()

    await expect(
      mc.inviteUser('!room42:matrix.test', '@alice:matrix.test')
    ).resolves.toBeUndefined()
  })

  it('throws on a non-idempotent failure (e.g. room not found)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errcode: 'M_NOT_FOUND', error: 'Unknown room' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    )
    const { getMatrixClient } = await import('./matrix-client')
    const mc = getMatrixClient()

    await expect(
      mc.inviteUser('!room42:matrix.test', '@alice:matrix.test')
    ).rejects.toThrow(/404/)
  })
})

// FLOW-MSG-001 (TASK-009 lane B, T6-T14 support): room-admin state/alias
// primitives, all authenticated as the admin bot (never a per-user token).
describe('MatrixClient.getRoomState / setRoomState / putRoomAlias / deleteRoomAlias', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('getRoomState GETs the state event with the admin token and returns the parsed body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ org_unit_id: 'u1', archived_at: '2026-09-24T00:00:00Z' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    const { getMatrixClient } = await import('./matrix-client')
    const mc = getMatrixClient()

    const result = await mc.getRoomState('!room42:matrix.test', 'org.gremion.room.archived')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://matrix.test:8008/_matrix/client/v3/rooms/' +
        encodeURIComponent('!room42:matrix.test') +
        '/state/org.gremion.room.archived/'
    )
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer admin-token')
    expect(result).toEqual({ org_unit_id: 'u1', archived_at: '2026-09-24T00:00:00Z' })
  })

  it('getRoomState returns null on a 404 (state event absent — not archived)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errcode: 'M_NOT_FOUND' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    )
    const { getMatrixClient } = await import('./matrix-client')
    const mc = getMatrixClient()

    expect(await mc.getRoomState('!room42:matrix.test', 'org.gremion.room.archived')).toBeNull()
  })

  it('getRoomState propagates a non-404 failure', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errcode: 'M_FORBIDDEN', error: 'nope' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    )
    const { getMatrixClient } = await import('./matrix-client')
    const mc = getMatrixClient()

    await expect(
      mc.getRoomState('!room42:matrix.test', 'm.room.power_levels')
    ).rejects.toThrow(/403/)
  })

  it('LOW fix (round-1 deferred, r1-kernel-nav-roomsB2): getRoomState encodeURIComponent-wraps eventType, not just roomId/stateKey', async () => {
    const { getMatrixClient } = await import('./matrix-client')
    const mc = getMatrixClient()

    // No current caller passes anything but a constant, but a future one
    // that did could otherwise inject an extra path segment (or worse) via
    // an unencoded eventType.
    await mc.getRoomState('!room42:matrix.test', 'weird/type with space')

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://matrix.test:8008/_matrix/client/v3/rooms/' +
        encodeURIComponent('!room42:matrix.test') +
        '/state/' + encodeURIComponent('weird/type with space') + '/'
    )
  })

  // TASK-009 verifier FIX item 1: the archive marker must be attributable to
  // its sender, which the content-only read cannot show. getRoomStateEvent
  // reads the FULL event (?format=event, Synapse >= 1.124).
  it('getRoomStateEvent GETs ?format=event and returns sender + content', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        type: 'org.gremion.room.archived', state_key: '', sender: '@bot:matrix.test',
        content: { org_unit_id: 'u1' }, event_id: '$e',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    )
    const { getMatrixClient } = await import('./matrix-client')
    const mc = getMatrixClient()

    const ev = await mc.getRoomStateEvent('!room42:matrix.test', 'org.gremion.room.archived')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://matrix.test:8008/_matrix/client/v3/rooms/' +
        encodeURIComponent('!room42:matrix.test') +
        '/state/org.gremion.room.archived/?format=event'
    )
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer admin-token')
    expect(ev).toEqual({ sender: '@bot:matrix.test', content: { org_unit_id: 'u1' } })
  })

  it('getRoomStateEvent returns null on 404 and propagates any other failure', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 'M_NOT_FOUND' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 'M_FORBIDDEN' }), { status: 403 }))
    const { getMatrixClient } = await import('./matrix-client')
    const mc = getMatrixClient()

    expect(await mc.getRoomStateEvent('!r:matrix.test', 'm.room.create')).toBeNull()
    await expect(mc.getRoomStateEvent('!r:matrix.test', 'm.room.create')).rejects.toThrow(/403/)
  })

  it('getRoomStateEvent reports a sender-less body (server ignored format=event) as sender "" — never trusted', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ org_unit_id: 'u1' }), { status: 200 })
    )
    const { getMatrixClient } = await import('./matrix-client')
    const ev = await getMatrixClient().getRoomStateEvent('!r:matrix.test', 'org.gremion.room.archived')
    expect(ev?.sender).toBe('')
  })

  it('setRoomState PUTs the content to the state event with the admin token', async () => {
    const { getMatrixClient } = await import('./matrix-client')
    const mc = getMatrixClient()

    await mc.setRoomState('!room42:matrix.test', 'org.gremion.room.archived', '', {
      org_unit_id: 'u1',
      archived_at: '2026-09-24T00:00:00Z',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://matrix.test:8008/_matrix/client/v3/rooms/' +
        encodeURIComponent('!room42:matrix.test') +
        '/state/org.gremion.room.archived/'
    )
    expect(init.method).toBe('PUT')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer admin-token')
    expect(JSON.parse(init.body as string)).toEqual({
      org_unit_id: 'u1',
      archived_at: '2026-09-24T00:00:00Z',
    })
  })

  it('LOW fix (round-1 deferred, r1-kernel-nav-roomsB2): setRoomState encodeURIComponent-wraps eventType too', async () => {
    const { getMatrixClient } = await import('./matrix-client')
    const mc = getMatrixClient()

    await mc.setRoomState('!room42:matrix.test', 'weird/type with space', '', {})

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://matrix.test:8008/_matrix/client/v3/rooms/' +
        encodeURIComponent('!room42:matrix.test') +
        '/state/' + encodeURIComponent('weird/type with space') + '/'
    )
  })

  it('putRoomAlias PUTs {room_id} to the directory alias endpoint with the admin token', async () => {
    const { getMatrixClient } = await import('./matrix-client')
    const mc = getMatrixClient()

    await mc.putRoomAlias('#stura-archiv-vorstand-202609241200:matrix.test', '!room42:matrix.test')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://matrix.test:8008/_matrix/client/v3/directory/room/' +
        encodeURIComponent('#stura-archiv-vorstand-202609241200:matrix.test')
    )
    expect(init.method).toBe('PUT')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer admin-token')
    expect(JSON.parse(init.body as string)).toEqual({ room_id: '!room42:matrix.test' })
  })

  it('deleteRoomAlias DELETEs the directory alias with the admin token and returns ok on 200', async () => {
    const { getMatrixClient } = await import('./matrix-client')
    const mc = getMatrixClient()

    await expect(
      mc.deleteRoomAlias('#stura-vorstand:matrix.test')
    ).resolves.toBeUndefined()

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://matrix.test:8008/_matrix/client/v3/directory/room/' +
        encodeURIComponent('#stura-vorstand:matrix.test')
    )
    expect(init.method).toBe('DELETE')
  })

  it('deleteRoomAlias treats a 404 (alias already gone) as ok — no throw', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errcode: 'M_NOT_FOUND' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    )
    const { getMatrixClient } = await import('./matrix-client')
    const mc = getMatrixClient()

    await expect(
      mc.deleteRoomAlias('#stura-vorstand:matrix.test')
    ).resolves.toBeUndefined()
  })
})
