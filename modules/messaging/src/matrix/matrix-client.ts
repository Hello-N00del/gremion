// services/messages/src/matrix/matrix-client.ts
// Leaf-side thin Matrix Client-Server API forwarder. Standalone (node built-ins +
// global fetch only — no SvelteKit, no workspace deps): the leaf reads its own
// MATRIX_URL from env and performs the CS-API op AS the per-request user (or the
// admin bot). This is the forwarding the MESSAGES_BACKEND=service cutover wires
// into http/dispatch.ts's router.
//
// Mirrors the kernel gremion-ui/src/lib/server/messages/matrix-client.ts CS calls
// + response NORMALIZATION (sync/getMessages filtering, unread counting) so the
// leaf returns the SAME shapes the kernel MatrixClient returns — stripped of the
// per-tenant client registry + token cache (the leaf resolves tenant/config per
// request from headers + env; a token cache is unnecessary because the kernel
// caches the exchanged token on its side).

import { randomUUID } from 'node:crypto'

const DEFAULT_MATRIX_URL = 'http://matrix:8008'

/** The Synapse base URL from the leaf's OWN env (trailing slash stripped). */
export function matrixBaseUrl(): string {
  return (process.env.MATRIX_URL ?? DEFAULT_MATRIX_URL).replace(/\/$/, '')
}

/** A normalized Matrix message event (mirrors the kernel MatrixMessage). */
export interface MatrixMessage {
  eventId: string
  sender: string
  senderDisplayName: string
  type: string
  body: string
  url?: string
  ts: number
}

/** A normalized /sync snapshot (mirrors the kernel SyncResponse). */
export interface SyncResponse {
  nextBatch: string
  rooms: {
    roomId: string
    events: MatrixMessage[]
    unreadCount: number
  }[]
}

export interface MatrixClientOptions {
  /** Synapse base URL (e.g. from matrixBaseUrl()). */
  baseUrl: string
  /** Optional server admin token for admin-scoped CS/media calls. */
  adminToken?: string
  /** Optional Synapse server name (for createRoom alias adoption). */
  serverName?: string
}

export interface MatrixLeafClient {
  /** Exchange a Keycloak JWT for a Synapse access token (JWT login). */
  getMatrixToken(keycloakJwt: string, deviceId?: string): Promise<string>
  /** Low-level CS-API round-trip (JSON in/out) as `token`. */
  cs(method: string, path: string, token: string, body?: unknown): Promise<unknown>
  /** Resolve a token's Matrix user id + device id via /account/whoami. */
  whoami(token: string): Promise<{ userId: string; deviceId: string }>
  /** Long-poll /sync → the normalized SyncResponse. */
  sync(userToken: string, since?: string): Promise<SyncResponse>
  /** The caller's joined room ids. */
  getJoinedRooms(userToken: string): Promise<string[]>
  /** Per-room unread *message* counts (excludes membership invites). */
  unreadMessageCountsByRoom(userToken: string): Promise<Map<string, number>>
  /** Room message history (dir=b). */
  getMessages(userToken: string, roomId: string, from?: string): Promise<{ messages: MatrixMessage[]; end: string }>
  /** Send a message → the new event id. */
  sendMessage(userToken: string, roomId: string, content: { msgtype: string; body: string; url?: string }): Promise<string>
  /** Advance the user's read markers in a room. */
  setReadMarker(userToken: string, roomId: string, eventId: string): Promise<void>
  /** Set/clear the typing indicator for a user in a room. */
  sendTyping(userToken: string, roomId: string, userId: string, typing: boolean): Promise<void>
  /** Upload media as the user → the mxc:// URI. */
  uploadMedia(userToken: string, data: ArrayBuffer, mimeType: string, filename: string): Promise<string>
  /** Download media (admin token) → bytes + content type. */
  downloadMedia(mxcUri: string): Promise<{ data: ArrayBuffer; contentType: string }>
  /** Create (or idempotently adopt by alias) a room as the admin bot → roomId. */
  createRoom(name: string, topic: string, aliasLocalpart?: string): Promise<string>
  /** Invite a user to a room as the admin bot (idempotent). */
  inviteUser(roomId: string, userId: string): Promise<void>
  /** Join a room with the user's own token (idempotent). */
  joinRoom(userToken: string, roomIdOrAlias: string): Promise<void>
}

/** A non-2xx Synapse response, carrying the Matrix errcode so dispatch can hand
 *  the kernel a structured token-invalidation signal (M_UNKNOWN_TOKEN).
 *  `userToken` is true only when the rejected bearer was a per-request USER
 *  token (never the admin token, never a tokenless login). */
export class MatrixHttpError extends Error {
  constructor(message: string, readonly status: number, readonly errcode?: string, readonly userToken = false) {
    super(message)
    this.name = 'MatrixHttpError'
  }
}

export function createMatrixClient(opts: MatrixClientOptions): MatrixLeafClient {
  const baseUrl = opts.baseUrl.replace(/\/$/, '')
  const adminToken = opts.adminToken ?? ''
  const serverName = opts.serverName ?? ''

  async function cs(method: string, path: string, token: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(baseUrl + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string; errcode?: string }
      throw new MatrixHttpError(`Matrix ${method} ${path} → ${res.status}: ${err.error ?? ''}`, res.status, err.errcode, token !== '')
    }
    if (res.status === 204) return null
    return res.json()
  }

  async function getMatrixToken(keycloakJwt: string, deviceId?: string): Promise<string> {
    const loginBody: Record<string, unknown> = { type: 'org.matrix.login.jwt', token: keycloakJwt }
    if (deviceId) loginBody.device_id = deviceId
    const res = await cs('POST', '/_matrix/client/v3/login', '', loginBody)
    return (res as { access_token: string }).access_token
  }

  async function whoami(token: string): Promise<{ userId: string; deviceId: string }> {
    const res = (await cs('GET', '/_matrix/client/v3/account/whoami', token)) as {
      user_id?: string
      device_id?: string
    }
    return { userId: res.user_id ?? '', deviceId: res.device_id ?? '' }
  }

  async function getRoomIdByAlias(alias: string): Promise<string | null> {
    const res = await fetch(`${baseUrl}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    if (res.status === 404) return null
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(`Matrix GET directory/room/${alias} → ${res.status}: ${err.error ?? ''}`)
    }
    return ((await res.json()) as { room_id: string }).room_id
  }

  async function unreadMessageCountsByRoom(userToken: string): Promise<Map<string, number>> {
    const counts = new Map<string, number>()
    try {
      const raw = (await cs('GET', '/_matrix/client/v3/notifications?limit=1000', userToken)) as {
        notifications?: Array<{ room_id?: string; read?: boolean; event?: { type?: string } }>
      }
      for (const n of raw.notifications ?? []) {
        if (n.read) continue
        const type = n.event?.type
        if (type !== 'm.room.message' && type !== 'm.room.encrypted') continue
        if (!n.room_id) continue
        counts.set(n.room_id, (counts.get(n.room_id) ?? 0) + 1)
      }
    } catch {
      // Swallowed — graceful degradation to 0 (mirrors the kernel).
    }
    return counts
  }

  async function sync(userToken: string, since?: string): Promise<SyncResponse> {
    const params = new URLSearchParams({ timeout: '30000' })
    if (since) params.set('since', since)
    const raw = (await cs('GET', `/_matrix/client/v3/sync?${params.toString()}`, userToken)) as {
      next_batch: string
      rooms?: {
        join?: Record<
          string,
          {
            timeline?: { events?: Array<{ event_id: string; sender: string; type: string; content: { body?: string; msgtype?: string; url?: string }; origin_server_ts: number }> }
            unread_notifications?: { notification_count?: number }
          }
        >
      }
    }

    const messageUnread = await unreadMessageCountsByRoom(userToken)

    const rooms: SyncResponse['rooms'] = []
    for (const [roomId, room] of Object.entries(raw.rooms?.join ?? {})) {
      const events = (room.timeline?.events ?? [])
        .filter((e) => e.type === 'm.room.message')
        .map(
          (e): MatrixMessage => ({
            eventId: e.event_id,
            sender: e.sender,
            senderDisplayName: e.sender,
            type: e.content.msgtype ?? e.type,
            body: e.content.body ?? '',
            url: undefined,
            ts: e.origin_server_ts,
          }),
        )
      rooms.push({ roomId, events, unreadCount: messageUnread.get(roomId) ?? 0 })
    }
    return { nextBatch: raw.next_batch, rooms }
  }

  async function getJoinedRooms(userToken: string): Promise<string[]> {
    const res = await cs('GET', '/_matrix/client/v3/joined_rooms', userToken)
    return (res as { joined_rooms: string[] }).joined_rooms
  }

  async function getMessages(userToken: string, roomId: string, from?: string): Promise<{ messages: MatrixMessage[]; end: string }> {
    const params = new URLSearchParams({ dir: 'b', limit: '50' })
    if (from) params.set('from', from)
    const raw = (await cs('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${params.toString()}`, userToken)) as {
      chunk: Array<{ event_id: string; sender: string; type: string; content: { body?: string; msgtype?: string; url?: string }; origin_server_ts: number }>
      end: string
    }
    const messages = raw.chunk
      .filter((e) => e.type === 'm.room.message')
      .map(
        (e): MatrixMessage => ({
          eventId: e.event_id,
          sender: e.sender,
          senderDisplayName: e.sender,
          type: e.content.msgtype ?? e.type,
          body: e.content.body ?? '',
          url: undefined,
          ts: e.origin_server_ts,
        }),
      )
    return { messages, end: raw.end }
  }

  async function sendMessage(userToken: string, roomId: string, content: { msgtype: string; body: string; url?: string }): Promise<string> {
    const txnId = randomUUID()
    const res = await cs('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, userToken, content)
    return (res as { event_id: string }).event_id
  }

  async function setReadMarker(userToken: string, roomId: string, eventId: string): Promise<void> {
    await cs('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/read_markers`, userToken, {
      'm.fully_read': eventId,
      'm.read': eventId,
    })
  }

  async function sendTyping(userToken: string, roomId: string, userId: string, typing: boolean): Promise<void> {
    await cs('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`, userToken, {
      typing,
      timeout: typing ? 30000 : 0,
    })
  }

  async function uploadMedia(userToken: string, data: ArrayBuffer, mimeType: string, filename: string): Promise<string> {
    const params = new URLSearchParams({ filename })
    const res = await fetch(`${baseUrl}/_matrix/media/v3/upload?${params.toString()}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': mimeType },
      body: data,
    })
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { errcode?: string }
      throw new MatrixHttpError(`Media upload failed: ${res.status}`, res.status, err.errcode, true)
    }
    return ((await res.json()) as { content_uri: string }).content_uri
  }

  async function downloadMedia(mxcUri: string): Promise<{ data: ArrayBuffer; contentType: string }> {
    // SSRF guard: only allow mxc:// URIs.
    if (!mxcUri.startsWith('mxc://')) throw new Error('Invalid mxc URI: must start with mxc://')
    const [server, mediaId] = mxcUri.slice('mxc://'.length).split('/')
    if (!server || !mediaId) throw new Error('Invalid mxc URI format')
    // Authenticated media (MSC3916, Synapse ≥1.156): the legacy unauthenticated
    // /_matrix/media/v3/download 404s once media is auth-gated. The CS-API
    // /_matrix/client/v1/media/download endpoint requires the admin token (sent
    // below) and serves the same bytes. Mirrors the kernel MatrixClient.
    const res = await fetch(`${baseUrl}/_matrix/client/v1/media/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    if (!res.ok) throw new Error(`Media download failed: ${res.status}`)
    const contentType = res.headers.get('Content-Type') ?? 'application/octet-stream'
    return { data: await res.arrayBuffer(), contentType }
  }

  async function createRoom(name: string, topic: string, aliasLocalpart?: string): Promise<string> {
    const body: Record<string, unknown> = {
      name,
      topic,
      preset: 'private_chat',
      power_level_content_override: {
        events: {
          'org.matrix.msc4143.rtc.member': 0,
          'org.matrix.msc3401.call.member': 0,
          'm.call.member': 0,
          'io.element.call.encryption_keys': 0,
        },
      },
    }
    if (aliasLocalpart) body.room_alias_name = aliasLocalpart

    const res = await fetch(`${baseUrl}/_matrix/client/v3/createRoom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { errcode?: string; error?: string }
      // Alias already registered (race or legacy room) — adopt it rather than failing.
      if (err.errcode === 'M_ROOM_IN_USE' && aliasLocalpart && serverName) {
        const existing = await getRoomIdByAlias(`#${aliasLocalpart}:${serverName}`)
        if (existing) return existing
      }
      throw new Error(`Matrix POST /_matrix/client/v3/createRoom → ${res.status}: ${err.error ?? ''}`)
    }
    return ((await res.json()) as { room_id: string }).room_id
  }

  async function inviteUser(roomId: string, userId: string): Promise<void> {
    const res = await fetch(`${baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ user_id: userId }),
    })
    if (res.ok) return
    const err = (await res.json().catch(() => ({}))) as { errcode?: string; error?: string }
    if (err.errcode === 'M_FORBIDDEN' && /already (in the room|invited)/i.test(err.error ?? '')) return
    throw new Error(`Matrix POST rooms/${roomId}/invite → ${res.status}: ${err.error ?? ''}`)
  }

  async function joinRoom(userToken: string, roomIdOrAlias: string): Promise<void> {
    await cs('POST', `/_matrix/client/v3/join/${encodeURIComponent(roomIdOrAlias)}`, userToken, {})
  }

  return {
    getMatrixToken,
    cs,
    whoami,
    sync,
    getJoinedRooms,
    unreadMessageCountsByRoom,
    getMessages,
    sendMessage,
    setReadMarker,
    sendTyping,
    uploadMedia,
    downloadMedia,
    createRoom,
    inviteUser,
    joinRoom,
  }
}
