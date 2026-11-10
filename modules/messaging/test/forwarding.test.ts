// services/messages/test/forwarding.test.ts
// The messages leaf is a THIN Matrix/LiveKit proxy. This test pins the two
// forwarding building blocks the cutover wires into the router (server.ts keeps
// them behind the 501 until then — see route-parity.test.ts):
//   1. the internal ACL (x-internal-auth timingSafeEqual + x-tenant-id/slug
//      resolution) sits in front of every forward (reuses http/auth.ts), and
//   2. at least one Matrix op (getMatrixToken → Synapse JWT login) and one
//      LiveKit op (mintLivekitToken) forward using the leaf's OWN env + the
//      per-request tenant, proving the leaf reads config from env/tenant headers
//      rather than the kernel.
//
// This is the RED test: it fails until src/matrix/matrix-client.ts +
// src/livekit/livekit-client.ts exist. The 18 route-parity tests stay green.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { checkGuard } from '../src/http/auth.ts'
import { createMatrixClient, matrixBaseUrl } from '../src/matrix/matrix-client.ts'
import { mintLivekitToken, roomNameFromMatrixId, dmRoomName, livekitRoomNamespace } from '../src/livekit/livekit-client.ts'
import { resolveMatrixCreds } from '../src/matrix/matrix-creds.ts'
import { createSynapseAdmin } from '../src/matrix/synapse-admin.ts'
import { corsHeaders, sfuTokenResponse, RoomMembershipError } from '../src/livekit/livekit-jwt.ts'
import { OPERATIONS } from '../src/operations.ts'
import { dispatchOp } from '../src/http/dispatch.ts'
import { buildEnvDeps } from '../src/http/deps.ts'

const SECRET = 'topsecret-shared-value'

function headers(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    'x-internal-auth': SECRET,
    'x-tenant-id': '11111111-1111-1111-1111-111111111111',
    'x-tenant-slug': 'alpha',
    ...over,
  }
}

function decodeJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = jwt.split('.')
  return {
    header: JSON.parse(Buffer.from(h!, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(p!, 'base64url').toString('utf8')),
  }
}

// ── ACL guard (timingSafeEqual secret + tenant-header resolution) ─────────────

describe('messages leaf ACL — guards every forward', () => {
  it('rejects a bad/missing x-internal-auth secret with 403 (constant-time)', () => {
    expect(checkGuard({ path: '/api/v1/messages/sync', headers: headers({ 'x-internal-auth': undefined }), secret: SECRET }).ok).toBe(false)
    expect(checkGuard({ path: '/api/v1/messages/sync', headers: headers({ 'x-internal-auth': 'wrong' }), secret: SECRET }).ok).toBe(false)
    const bad = checkGuard({ path: '/api/v1/messages/sync', headers: headers({ 'x-internal-auth': 'wrong' }), secret: SECRET })
    if (bad.ok) throw new Error('unreachable')
    expect(bad.status).toBe(403)
  })

  it('resolves x-tenant-id + x-tenant-slug for a valid request', () => {
    const r = checkGuard({ path: '/api/v1/video/token', headers: headers(), secret: SECRET })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.tenant).toEqual({ id: '11111111-1111-1111-1111-111111111111', slug: 'alpha' })
  })
})

// ── Matrix forwarding op — reads MATRIX_URL from the leaf's own env ────────────

describe('matrix forwarding — getMatrixToken exchanges a Keycloak JWT at Synapse', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    process.env.MATRIX_URL = 'http://synapse.internal:8008'
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs org.matrix.login.jwt to ${MATRIX_URL}/_matrix/client/v3/login and returns the access_token', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'mx_leaf_token' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    // Base URL comes from the leaf's OWN env (not the kernel), proving env config.
    expect(matrixBaseUrl()).toBe('http://synapse.internal:8008')
    const client = createMatrixClient({ baseUrl: matrixBaseUrl() })
    const token = await client.getMatrixToken('kc.jwt.here', 'DEVID')

    expect(token).toBe('mx_leaf_token')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://synapse.internal:8008/_matrix/client/v3/login')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      type: 'org.matrix.login.jwt',
      token: 'kc.jwt.here',
      device_id: 'DEVID',
    })
  })
})

// ── LiveKit forwarding op — mints an HS256 token from env key/secret + tenant ──

describe('livekit forwarding — mintLivekitToken signs a room-pinned grant', () => {
  it('mints an HS256 JWT with the API key as issuer and a room-pinned video grant', () => {
    const jwt = mintLivekitToken(
      { apiKey: 'APIkey123', apiSecret: 'this-secret-is-at-least-32-bytes-long!!' },
      'stura-room-abc',
      { identity: '@user:s', displayName: 'User', canPublish: true },
    )
    const { header, payload } = decodeJwt(jwt)
    expect(header.alg).toBe('HS256')
    expect(payload.iss).toBe('APIkey123')
    expect(payload.sub).toBe('@user:s')
    const grant = payload.video as { room: string; roomJoin: boolean; canPublish: boolean }
    expect(grant.room).toBe('stura-room-abc')
    expect(grant.roomJoin).toBe(true)
    expect(grant.canPublish).toBe(true)
  })

  it('applies the per-tenant room namespace (tenant-header config → room name)', () => {
    // TASK-042 TDD 14 (PRD-PLAT-012): every tenant is equal - a tenant whose
    // slug happens to be `default` gets the same t.<slug>. prefix as any other,
    // so rooms cannot collide across tenants.
    expect(livekitRoomNamespace('default')).toBe('t.default.')
    expect(livekitRoomNamespace('kreis')).toBe('t.kreis.')
    expect(roomNameFromMatrixId('default', '!abc123:matrix.example.com')).toBe('t.default.stura-room-abc123')
    expect(roomNameFromMatrixId('acme', '!abc123:matrix.example.com')).toBe('t.acme.stura-room-abc123')
    expect(dmRoomName('default', '@a:s', '@b:s')).toMatch(/^t\.default\.stura-dm-[0-9a-f]{16}$/)
    expect(dmRoomName('acme', '@a:s', '@b:s')).toMatch(/^t\.acme\.stura-dm-[0-9a-f]{16}$/)
  })
})

// ── Additional staged forwarding building blocks (cutover) ────────────────────

describe('matrix-creds forwarding — resolveMatrixCreds soft-fails', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('whoami OK → { userId, accessToken }', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ user_id: '@u:s' }), { status: 200 }))
    await expect(resolveMatrixCreds('http://synapse.internal:8008', 'mx')).resolves.toEqual({
      userId: '@u:s',
      accessToken: 'mx',
    })
  })

  it('whoami failure → empty creds WITHOUT throwing (soft-fail)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }))
    await expect(resolveMatrixCreds('http://synapse.internal:8008', 'mx')).resolves.toEqual({
      userId: '',
      accessToken: '',
    })
  })
})

describe('synapse-admin forwarding — forceJoinRoom is idempotent', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs to the admin join endpoint with the admin token + room/user', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const admin = createSynapseAdmin({ baseUrl: 'http://synapse.internal:8008', adminToken: 'adm' })
    await admin.forceJoinRoom('!room:s', '@user:s')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://synapse.internal:8008/_synapse/admin/v1/join/' + encodeURIComponent('!room:s'))
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer adm')
    expect(JSON.parse(init.body as string)).toEqual({ user_id: '@user:s' })
  })

  it('swallows an "already in the room" error (idempotent re-join)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'User is already in the room' }), { status: 403 }),
    )
    const admin = createSynapseAdmin({ baseUrl: 'http://synapse.internal:8008', adminToken: 'adm' })
    await expect(admin.forceJoinRoom('!room:s', '@user:s')).resolves.toBeUndefined()
  })
})

describe('livekit-jwt SFU helpers (staged; the live SFU mint stays kernel-side/exempt)', () => {
  it('corsHeaders allow the element-call widget origin', () => {
    expect(corsHeaders()['Access-Control-Allow-Origin']).toBe('*')
    expect(corsHeaders()['Access-Control-Allow-Methods']).toContain('POST')
  })
  it('sfuTokenResponse wraps a JWT in the MSC4195 envelope', () => {
    expect(sfuTokenResponse('the.jwt')).toEqual({ access_token: 'the.jwt', token_type: 'Bearer', expires_in: 3600 })
  })
  it('RoomMembershipError is an authorization-failure marker', () => {
    expect(new RoomMembershipError().name).toBe('RoomMembershipError')
  })
})

// ── Per-op leaf-handler forwarding (dispatchOp) ───────────────────────────────
// The cutover fills http/server.ts's router (501 until now) with real per-op
// forwarding. This block pins ONE test per op: it stubs global fetch to
// Synapse/LiveKit and asserts dispatchOp() returns the EXACT
// service-client/openapi JSON envelope. buildEnvDeps() builds the leaf's
// env-configured Matrix/Synapse/LiveKit clients — which call the (stubbed)
// global fetch — so this exercises the real forwarding path, mocking only the
// network. Covers all 14 ops incl. base64 media round-trip, the
// video.meeting-room admin multiplex (create/invite/join/forceJoin + #370
// listRooms→roomIds), and the openid-token/widget-action leaf handlers.

describe('leaf op forwarding (dispatchOp) — contract-identical envelopes', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    process.env.MATRIX_URL = 'http://synapse.internal:8008'
    process.env.SYNAPSE_ADMIN_TOKEN = 'admtok'
    process.env.SYNAPSE_SERVER_NAME = 'stura.local'
    process.env.LIVEKIT_API_KEY = 'APIkey123'
    process.env.LIVEKIT_API_SECRET = 'this-secret-is-at-least-32-bytes-long!!'
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const findOp = (id: string) => {
    const o = OPERATIONS.find((x) => x.op === id)
    if (!o) throw new Error(`no such op ${id}`)
    return o
  }
  const run = (id: string, body: Record<string, unknown>) => dispatchOp(findOp(id), body, buildEnvDeps())

  const jr = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  interface Handler {
    match: (url: string, init?: RequestInit) => boolean
    res: () => Response
  }
  function route(handlers: Handler[]): void {
    fetchMock.mockImplementation((url: unknown, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : (url as URL).href
      for (const h of handlers) if (h.match(u, init)) return Promise.resolve(h.res())
      throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${u}`)
    })
  }

  // ── messages.* ──────────────────────────────────────────────────────────────
  it('messages.sync → normalized SyncResponse (with per-room unread)', async () => {
    route([
      {
        match: (u) => u.includes('/_matrix/client/v3/sync'),
        res: () =>
          jr({
            next_batch: 'nb1',
            rooms: {
              join: {
                '!r:s': {
                  timeline: { events: [{ event_id: '$e', sender: '@a:s', type: 'm.room.message', content: { body: 'hi', msgtype: 'm.text' }, origin_server_ts: 100 }] },
                  unread_notifications: { notification_count: 9 },
                },
              },
            },
          }),
      },
      { match: (u) => u.includes('/_matrix/client/v3/notifications'), res: () => jr({ notifications: [{ room_id: '!r:s', read: false, event: { type: 'm.room.message' } }] }) },
    ])
    const r = await run('messages.sync', { userToken: 'tok', since: 's0' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      nextBatch: 'nb1',
      rooms: [{ roomId: '!r:s', events: [{ eventId: '$e', sender: '@a:s', senderDisplayName: '@a:s', type: 'm.text', body: 'hi', url: undefined, ts: 100 }], unreadCount: 1 }],
    })
  })

  it('messages.rooms → { rooms } (joined room ids)', async () => {
    route([{ match: (u) => u.includes('/_matrix/client/v3/joined_rooms'), res: () => jr({ joined_rooms: ['!a:s', '!b:s'] }) }])
    const r = await run('messages.rooms', { userToken: 'tok' })
    expect(r.body).toEqual({ rooms: ['!a:s', '!b:s'] })
  })

  it('messages.rooms (unread=true) → { counts } (per-room message unread)', async () => {
    route([{ match: (u) => u.includes('/_matrix/client/v3/notifications'), res: () => jr({ notifications: [{ room_id: '!a:s', read: false, event: { type: 'm.room.message' } }, { room_id: '!a:s', read: false, event: { type: 'm.room.message' } }] }) }])
    const r = await run('messages.rooms', { userToken: 'tok', unread: true })
    expect(r.body).toEqual({ counts: { '!a:s': 2 } })
  })

  it('messages.list → { messages, end }', async () => {
    route([{ match: (u, init) => u.includes('/messages') && (init?.method ?? 'GET') === 'GET', res: () => jr({ chunk: [{ event_id: '$e', sender: '@a:s', type: 'm.room.message', content: { body: 'hi', msgtype: 'm.text' }, origin_server_ts: 5 }], end: 'END' }) }])
    const r = await run('messages.list', { userToken: 'tok', roomId: '!r:s', from: 'F' })
    expect(r.body).toEqual({ messages: [{ eventId: '$e', sender: '@a:s', senderDisplayName: '@a:s', type: 'm.text', body: 'hi', url: undefined, ts: 5 }], end: 'END' })
  })

  it('messages.send → { eventId }', async () => {
    route([{ match: (u) => u.includes('/send/m.room.message/'), res: () => jr({ event_id: '$sent' }) }])
    const r = await run('messages.send', { userToken: 'tok', roomId: '!r:s', content: { msgtype: 'm.text', body: 'hi' } })
    expect(r.body).toEqual({ eventId: '$sent' })
  })

  it('messages.read → { success:true }', async () => {
    route([{ match: (u) => u.includes('/read_markers'), res: () => jr({}) }])
    const r = await run('messages.read', { userToken: 'tok', roomId: '!r:s', eventId: '$e' })
    expect(r.body).toEqual({ success: true })
  })

  it('messages.typing → { success:true }', async () => {
    route([{ match: (u) => u.includes('/typing/'), res: () => jr({}) }])
    const r = await run('messages.typing', { userToken: 'tok', roomId: '!r:s', userId: '@u:s', typing: true })
    expect(r.body).toEqual({ success: true })
  })

  it('messages.media.upload → { mxc } (base64 request body decoded to the uploaded bytes)', async () => {
    let uploaded: string | undefined
    route([{ match: (u) => u.includes('/_matrix/media/v3/upload'), res: () => jr({ content_uri: 'mxc://s/abc' }) }])
    fetchMock.mockImplementation((u: unknown, init?: RequestInit) => {
      uploaded = Buffer.from(init!.body as ArrayBuffer).toString('utf8')
      return Promise.resolve(jr({ content_uri: 'mxc://s/abc' }))
    })
    const r = await run('messages.media.upload', { userToken: 'tok', mimeType: 'image/png', filename: 'f.png', data: Buffer.from('PNGDATA').toString('base64') })
    expect(r.body).toEqual({ mxc: 'mxc://s/abc' })
    expect(uploaded).toBe('PNGDATA')
  })

  it('messages.media.download → { data(base64), contentType } (base64 round-trip)', async () => {
    route([{ match: (u) => u.includes('/_matrix/client/v1/media/download'), res: () => new Response(Buffer.from('BINARYBYTES'), { status: 200, headers: { 'content-type': 'image/gif' } }) }])
    const r = await run('messages.media.download', { mxcUri: 'mxc://s/abc' })
    const body = r.body as { data: string; contentType: string }
    expect(body.contentType).toBe('image/gif')
    expect(Buffer.from(body.data, 'base64').toString('utf8')).toBe('BINARYBYTES')
  })

  // ── video.* ─────────────────────────────────────────────────────────────────
  it('video.token → { token } (HS256 room-pinned LiveKit JWT; NO upstream fetch)', async () => {
    route([])
    const r = await run('video.token', { roomName: 'stura-room-abc', identity: '@u:s', displayName: 'U', canPublish: true })
    const body = r.body as { token: string }
    const [h, p] = body.token.split('.')
    const header = JSON.parse(Buffer.from(h!, 'base64url').toString('utf8'))
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString('utf8'))
    expect(header.alg).toBe('HS256')
    expect(payload.iss).toBe('APIkey123')
    expect(payload.video.room).toBe('stura-room-abc')
    expect(payload.video.canPublish).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('video.meeting-room (create) → { roomId }', async () => {
    route([{ match: (u, init) => u.includes('/createRoom') && init?.method === 'POST', res: () => jr({ room_id: '!new:s' }) }])
    const r = await run('video.meeting-room', { name: 'N', topic: 'T', aliasLocalpart: 'meeting-x' })
    expect(r.body).toEqual({ roomId: '!new:s' })
  })

  it('video.meeting-room (invite) → { success:true }', async () => {
    route([{ match: (u) => u.includes('/rooms/') && u.includes('/invite'), res: () => jr({}) }])
    const r = await run('video.meeting-room', { invite: { roomId: '!r:s', userId: '@u:s' } })
    expect(r.body).toEqual({ success: true })
  })

  it('video.meeting-room (join) → { success:true }', async () => {
    route([{ match: (u) => u.includes('/_matrix/client/v3/join/'), res: () => jr({}) }])
    const r = await run('video.meeting-room', { join: { userToken: 'tok', roomIdOrAlias: '!r:s' } })
    expect(r.body).toEqual({ success: true })
  })

  it('video.meeting-room (forceJoin, synapse admin) → { success:true }', async () => {
    route([{ match: (u) => u.includes('/_synapse/admin/v1/join/'), res: () => jr({}) }])
    const r = await run('video.meeting-room', { forceJoin: { roomId: '!r:s', userId: '@u:s' } })
    expect(r.body).toEqual({ success: true })
  })

  it('video.meeting-room (#370 listRooms, synapse admin) → { roomIds }', async () => {
    route([{ match: (u) => u.includes('/_synapse/admin/v1/rooms'), res: () => jr({ rooms: [{ room_id: '!a:s' }, { room_id: '!b:s' }] }) }])
    const r = await run('video.meeting-room', { listRooms: true })
    expect(r.body).toEqual({ roomIds: ['!a:s', '!b:s'] })
  })

  it('video.openid-token → { userId, openidToken }', async () => {
    route([
      { match: (u) => u.includes('/account/whoami'), res: () => jr({ user_id: '@u:s' }) },
      { match: (u) => u.includes('/openid/request_token'), res: () => jr({ access_token: 'oid', token_type: 'Bearer', matrix_server_name: 'stura.local', expires_in: 3600 }) },
    ])
    const r = await run('video.openid-token', { userToken: 'tok' })
    expect(r.body).toEqual({ userId: '@u:s', openidToken: { access_token: 'oid', token_type: 'Bearer', matrix_server_name: 'stura.local', expires_in: 3600 } })
  })

  it('video.widget-action (send_event) → { eventId }', async () => {
    route([{ match: (u, init) => u.includes('/send/') && init?.method === 'PUT', res: () => jr({ event_id: '$w' }) }])
    const r = await run('video.widget-action', { userToken: 'tok', action: 'send_event', roomId: '!r:s', type: 'm.reaction', content: {} })
    expect(r.body).toEqual({ eventId: '$w' })
  })

  it('video.widget-action (read_events) → { events }', async () => {
    route([{ match: (u, init) => u.endsWith('/state') && (init?.method ?? 'GET') === 'GET', res: () => jr([{ type: 'm.room.member', state_key: '@u:s' }, { type: 'm.call.member', state_key: '@u:s' }]) }])
    const r = await run('video.widget-action', { userToken: 'tok', action: 'read_events', roomId: '!r:s', type: 'm.call.member' })
    expect(r.body).toEqual({ events: [{ type: 'm.call.member', state_key: '@u:s' }] })
  })

  // ── auth.* ──────────────────────────────────────────────────────────────────
  it('auth.matrix-token → { matrixToken, matrixUserId, matrixDeviceId } (login + whoami)', async () => {
    route([
      { match: (u) => u.includes('/_matrix/client/v3/login'), res: () => jr({ access_token: 'mx_tok' }) },
      { match: (u) => u.includes('/_matrix/client/v3/account/whoami'), res: () => jr({ user_id: '@u:s', device_id: 'DEV1' }) },
    ])
    const r = await run('auth.matrix-token', { keycloakJwt: 'kc.jwt', deviceId: 'DEV1' })
    expect(r.body).toEqual({ matrixToken: 'mx_tok', matrixUserId: '@u:s', matrixDeviceId: 'DEV1' })
  })

  it('auth.matrix-device → { success:true } (forms @localpart:SERVER_NAME, DELETE device via admin)', async () => {
    let deleteUrl: string | undefined
    route([{ match: (u, init) => u.includes('/devices/') && init?.method === 'DELETE', res: () => jr({}) }])
    fetchMock.mockImplementation((u: unknown, init?: RequestInit) => {
      deleteUrl = typeof u === 'string' ? u : (u as URL).href
      expect(init?.method).toBe('DELETE')
      return Promise.resolve(jr({}))
    })
    const r = await run('auth.matrix-device', { localpart: 'alice', deviceId: 'DEVX' })
    expect(r.body).toEqual({ success: true })
    // G-022: the leaf (not the kernel) forms @{localpart}:{SYNAPSE_SERVER_NAME}.
    expect(deleteUrl).toContain(encodeURIComponent('@alice:stura.local'))
    expect(deleteUrl).toContain('/devices/DEVX')
  })

  // ── upstream error → 502 ──────────────────────────────────────────────────────
  it('an upstream failure maps to 502 (UpstreamError envelope), never throws out of dispatch', async () => {
    route([{ match: (u) => u.includes('/_matrix/client/v3/login'), res: () => jr({ error: 'boom' }, 500) }])
    const r = await run('auth.matrix-token', { keycloakJwt: 'kc.jwt' })
    expect(r.status).toBe(502)
    expect((r.body as { success: boolean }).success).toBe(false)
  })

  // Token-invalidation signal: Synapse M_UNKNOWN_TOKEN must reach the kernel as a
  // structured `errcode` so it can evict the dead cached Matrix token.
  it('a Synapse 401 M_UNKNOWN_TOKEN on a user-token op carries errcode in the envelope (status stays 502)', async () => {
    route([{ match: (u) => u.includes('joined_rooms'), res: () => jr({ errcode: 'M_UNKNOWN_TOKEN', error: 'Unrecognised access token.' }, 401) }])
    const r = await run('messages.rooms', { userToken: 'dead-token' })
    expect(r.status).toBe(502)
    expect((r.body as { errcode?: string }).errcode).toBe('M_UNKNOWN_TOKEN')
  })

  it('media upload: a Synapse 401 M_UNKNOWN_TOKEN carries errcode in the envelope', async () => {
    route([{ match: (u) => u.includes('/media/v3/upload'), res: () => jr({ errcode: 'M_UNKNOWN_TOKEN', error: 'Unrecognised access token.' }, 401) }])
    const r = await run('messages.media.upload', { userToken: 'dead', data: 'AAAA', mimeType: 'image/png', filename: 'a.png' })
    expect(r.status).toBe(502)
    expect((r.body as { errcode?: string }).errcode).toBe('M_UNKNOWN_TOKEN')
  })

  // The next two pin the narrowing: they pass before the eviction work too (no
  // errcode is ever emitted then) and must stay green after it.
  it('an admin-token 401 (media download) is NOT mapped to M_UNKNOWN_TOKEN', async () => {
    route([{ match: (u) => u.includes('/media/download'), res: () => jr({ errcode: 'M_UNKNOWN_TOKEN', error: 'bad admin' }, 401) }])
    const r = await run('messages.media.download', { mxcUri: 'mxc://example.org/abc' })
    expect(r.status).toBe(502)
    expect((r.body as { errcode?: string }).errcode).toBeUndefined()
  })

  it('a tokenless login 401 (bad Keycloak JWT) is NOT mapped to M_UNKNOWN_TOKEN', async () => {
    route([{ match: (u) => u.includes('/_matrix/client/v3/login'), res: () => jr({ error: 'nope' }, 401) }])
    const r = await run('auth.matrix-token', { keycloakJwt: 'kc.jwt' })
    expect((r.body as { errcode?: string }).errcode).toBeUndefined()
  })
})
