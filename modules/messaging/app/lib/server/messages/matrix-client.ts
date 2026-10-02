import { env } from '$env/dynamic/private'
import { currentTenantId, getTenant } from '$lib/server/tenant/context'
import { defaultTenantEnv } from '$lib/server/tenant/default-env'
import { resolveSecret } from '$lib/server/tenant/secrets'

// Cache Matrix access tokens per Keycloak user sub.
// Avoids a /login round-trip on every API request and prevents 429s.
interface CachedMatrixToken {
  matrixToken: string
  // Expire the cache slightly before the Keycloak JWT expires
  expiresAt: number
}
const matrixTokenCache = new Map<string, CachedMatrixToken>()
// In-flight login promises per cache key — prevents concurrent cache misses from
// all firing a /login request simultaneously (thundering herd on server restart).
const matrixTokenInflight = new Map<string, Promise<string>>()

/** Decode a JWT payload without verifying the signature (server-side only). */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  try {
    const part = jwt.split('.')[1] ?? ''
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf-8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export interface MatrixRoom {
  roomId: string
  name: string
  topic?: string
  unreadCount: number
  lastMessageTs: number
}

export interface MatrixMessage {
  eventId: string
  sender: string
  senderDisplayName: string
  type: string
  body: string
  url?: string // proxied URL, never mxc://
  ts: number
}

export interface SyncResponse {
  nextBatch: string
  rooms: {
    roomId: string
    events: MatrixMessage[]
    unreadCount: number
  }[]
}

class MatrixClient {
  private readonly baseUrl: string
  private readonly adminToken: string
  private readonly adminBotUserId: string

  constructor(url: string, token: string, botId: string) {
    this.baseUrl = url.replace(/\/$/, '')
    this.adminToken = token
    this.adminBotUserId = botId
  }

  private async cs(
    method: string,
    path: string,
    token: string,
    body?: unknown
  ): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`Matrix ${method} ${path} → ${res.status}: ${(err as { error?: string }).error ?? ''}`)
    }
    if (res.status === 204) return null
    return res.json()
  }

  // Exchange Keycloak access token for a Matrix access token.
  // Pass deviceId to reuse an existing Synapse device — prevents OLM state churn.
  // Caches the result per user+device; deduplicates concurrent inflight requests
  // for the same user (prevents thundering herd on server restart).
  async getMatrixToken(keycloakJwt: string, deviceId?: string): Promise<string> {
    const payload = decodeJwtPayload(keycloakJwt)
    const sub = (payload.sub as string | undefined) ?? keycloakJwt.slice(-20)
    const keycloakExp = typeof payload.exp === 'number' ? payload.exp * 1000 : 0
    const tenantId = currentTenantId()
    const subKey = deviceId ? `${sub}:${deviceId}` : sub
    const cacheKey = `${tenantId}|${subKey}`

    // Check cache first — a valid cached Matrix token can still be used even if
    // the Keycloak JWT has since expired (Matrix token lives up to 1 hour).
    const cached = matrixTokenCache.get(cacheKey)
    if (cached && Date.now() < cached.expiresAt) {
      return cached.matrixToken
    }

    // Deduplicate concurrent logins for the same user — return the same promise.
    const inflight = matrixTokenInflight.get(cacheKey)
    if (inflight) return inflight

    // No cached token — require a valid Keycloak JWT to exchange for a new one
    if (keycloakExp > 0 && Date.now() >= keycloakExp) {
      throw new Error('Keycloak JWT is expired — session refresh required')
    }

    const loginBody: Record<string, unknown> = {
      type: 'org.matrix.login.jwt',
      token: keycloakJwt
    }
    // Passing device_id causes Synapse to reuse the existing device rather than
    // creating a new one — keeps OLM key material stable across token refreshes.
    if (deviceId) loginBody.device_id = deviceId

    const loginPromise = this.cs('POST', '/_matrix/client/v3/login', '', loginBody)
      .then((res) => {
        const matrixToken = (res as { access_token: string }).access_token
        // Cache until 60 s before the Keycloak token expires (max 1 hour)
        const cacheUntil = keycloakExp > 0
          ? Math.min(keycloakExp - 60_000, Date.now() + 3_600_000)
          : Date.now() + 3_600_000
        matrixTokenCache.set(cacheKey, { matrixToken, expiresAt: cacheUntil })
        return matrixToken
      })
      .finally(() => {
        matrixTokenInflight.delete(cacheKey)
      })

    matrixTokenInflight.set(cacheKey, loginPromise)
    return loginPromise
  }

  // Resolve a room alias (e.g. "#stura-vorstand:srv") to its room id.
  // Returns the room_id on 200, null on 404 (alias not registered), and lets
  // genuinely-unexpected errors surface. Used by provisioning to adopt a room
  // that survived a Postgres wipe instead of minting a duplicate.
  async getRoomIdByAlias(alias: string): Promise<string | null> {
    const res = await fetch(
      `${this.baseUrl}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      { headers: { Authorization: `Bearer ${this.adminToken}` } }
    )
    if (res.status === 404) return null
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(
        `Matrix GET directory/room/${alias} → ${res.status}: ${(err as { error?: string }).error ?? ''}`
      )
    }
    return (await res.json() as { room_id: string }).room_id
  }

  // Create a room as the admin bot and return its roomId.
  // When `aliasLocalpart` is given (the localpart only — without the leading '#'
  // and without the ':server' suffix), the room is created with that canonical
  // alias so future reseeds can adopt it via getRoomIdByAlias. If the alias is
  // already taken (M_ROOM_IN_USE — a race or a legacy room), the existing room
  // is resolved and returned instead of throwing.
  async createRoom(name: string, topic: string, aliasLocalpart?: string): Promise<string> {
    const body: Record<string, unknown> = {
      name,
      topic,
      preset: 'private_chat',
      // Allow all members (PL 0) to publish their own RTC call membership and
      // E2EE key-exchange events. Without this override, the room's default
      // state_default of 50 blocks regular users from joining a call.
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

    const res = await fetch(this.baseUrl + '/_matrix/client/v3/createRoom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.adminToken}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { errcode?: string; error?: string }
      // Alias already registered (race or legacy room) — adopt that room rather
      // than failing the reseed.
      if (err.errcode === 'M_ROOM_IN_USE' && aliasLocalpart) {
        const serverName = this.adminBotUserId.split(':')[1] ?? ''
        const existing = await this.getRoomIdByAlias(`#${aliasLocalpart}:${serverName}`)
        if (existing) return existing
      }
      throw new Error(`Matrix POST /_matrix/client/v3/createRoom → ${res.status}: ${err.error ?? ''}`)
    }
    return (await res.json() as { room_id: string }).room_id
  }

  // Invite a user to a room as the admin bot. IDEMPOTENT: Synapse returns
  // M_FORBIDDEN with an "already in the room" / "already invited" message when
  // the target is already a member or has a pending invite — that is a success
  // for our purposes (we only want to guarantee membership), so it is swallowed.
  // Any other failure is thrown. Mirrors createRoom's fetch + error style.
  async inviteUser(roomId: string, userId: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.adminToken}` },
        body: JSON.stringify({ user_id: userId }),
      }
    )
    if (res.ok) return
    const err = (await res.json().catch(() => ({}))) as { errcode?: string; error?: string }
    // Already a member / already invited — nothing to do.
    if (err.errcode === 'M_FORBIDDEN' && /already (in the room|invited)/i.test(err.error ?? '')) {
      return
    }
    throw new Error(
      `Matrix POST rooms/${roomId}/invite → ${res.status}: ${err.error ?? ''}`
    )
  }

  // Join a room (or alias) with the USER's own token, so the caller becomes a
  // full member before the embedded call starts. IDEMPOTENT: re-joining a room
  // the user is already in is a Synapse no-op (returns 200), so this is safe to
  // call on every meeting-room request.
  async joinRoom(userToken: string, roomIdOrAlias: string): Promise<void> {
    await this.cs(
      'POST',
      `/_matrix/client/v3/join/${encodeURIComponent(roomIdOrAlias)}`,
      userToken,
      {}
    )
  }

  // Read a room's m.room.name state with the USER's own token. Returns the name,
  // or null when the room carries no name state or the read fails (callers fall
  // back to the room id). SECURITY (design v11 review): this goes through
  // this.baseUrl — the client is tenant-keyed, so the per-user token minted by
  // getMatrixToken (valid ONLY on this tenant's homeserver) is never transmitted
  // to another tenant's Synapse. A hand-built defaultTenantEnv('MATRIX_URL') URL
  // would leak a non-default tenant's token to the DEFAULT tenant's homeserver.
  async getRoomName(userToken: string, roomId: string): Promise<string | null> {
    try {
      const res = (await this.cs(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`,
        userToken
      )) as { name?: string }
      return res.name ?? null
    } catch {
      return null
    }
  }

  // Count unread *message* notifications per room.
  //
  // Synapse's per-room `notification_count` (returned by /sync) counts every
  // notifying event — including the `m.room.member` invite that fires the
  // `invite_for_me` push rule. Provisioning invites every member to their
  // org-unit rooms, so each such room carried one lingering invite notification,
  // inflating the "unread" badge by exactly one per room the user had unread
  // activity in (11 demo messages showed as 15). The /notifications endpoint
  // exposes per-event detail, so we count only unread message events — which is
  // what an "unread chat" badge is meant to reflect.
  //
  // Degrades to an empty map on any error so a /notifications hiccup can never
  // break sync() (and therefore the shell badge / messages page).
  // Public: also consumed by GET /api/messages/rooms (#188) to populate the
  // per-room unread badge on the initial room list, not only by sync().
  async unreadMessageCountsByRoom(userToken: string): Promise<Map<string, number>> {
    const counts = new Map<string, number>()
    try {
      const raw = (await this.cs(
        'GET',
        '/_matrix/client/v3/notifications?limit=1000',
        userToken
      )) as { notifications?: Array<{ room_id?: string; read?: boolean; event?: { type?: string } }> }
      for (const n of raw.notifications ?? []) {
        if (n.read) continue
        const type = n.event?.type
        if (type !== 'm.room.message' && type !== 'm.room.encrypted') continue
        if (!n.room_id) continue
        counts.set(n.room_id, (counts.get(n.room_id) ?? 0) + 1)
      }
    } catch {
      // Intentionally swallowed — see method docs (graceful degradation to 0).
    }
    return counts
  }

  // Long-poll sync.
  async sync(userToken: string, since?: string): Promise<SyncResponse> {
    const params = new URLSearchParams({ timeout: '30000' })
    if (since) params.set('since', since)
    const raw = await this.cs(
      'GET',
      `/_matrix/client/v3/sync?${params}`,
      userToken
    ) as {
      next_batch: string
      rooms?: {
        join?: Record<string, {
          timeline?: { events?: Array<{ event_id: string; sender: string; type: string; content: { body?: string; msgtype?: string; url?: string }; origin_server_ts: number }> }
          unread_notifications?: { notification_count?: number }
        }>
      }
    }

    // Per-room unread *message* counts (excludes the invite_for_me membership
    // notification that Synapse's notification_count would otherwise add).
    const messageUnread = await this.unreadMessageCountsByRoom(userToken)

    const rooms: SyncResponse['rooms'] = []
    for (const [roomId, room] of Object.entries(raw.rooms?.join ?? {})) {
      const events = (room.timeline?.events ?? [])
        .filter((e) => e.type === 'm.room.message')
        .map((e): MatrixMessage => ({
          eventId: e.event_id,
          sender: e.sender,
          senderDisplayName: e.sender,
          type: e.content.msgtype ?? e.type,
          body: e.content.body ?? '',
          url: undefined,
          ts: e.origin_server_ts
        }))
      rooms.push({
        roomId,
        events,
        unreadCount: messageUnread.get(roomId) ?? 0
      })
    }
    return { nextBatch: raw.next_batch, rooms }
  }

  async getMessages(
    userToken: string,
    roomId: string,
    from?: string
  ): Promise<{ messages: MatrixMessage[]; end: string }> {
    const params = new URLSearchParams({ dir: 'b', limit: '50' })
    if (from) params.set('from', from)
    const raw = await this.cs(
      'GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${params}`,
      userToken
    ) as { chunk: Array<{ event_id: string; sender: string; type: string; content: { body?: string; msgtype?: string; url?: string }; origin_server_ts: number }>; end: string }

    const messages = raw.chunk
      .filter((e) => e.type === 'm.room.message')
      .map((e): MatrixMessage => ({
        eventId: e.event_id,
        sender: e.sender,
        senderDisplayName: e.sender,
        type: e.content.msgtype ?? e.type,
        body: e.content.body ?? '',
        url: undefined,
        ts: e.origin_server_ts
      }))
    return { messages, end: raw.end }
  }

  async sendMessage(
    userToken: string,
    roomId: string,
    content: { msgtype: string; body: string; url?: string }
  ): Promise<string> {
    const txnId = crypto.randomUUID()
    const res = await this.cs(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      userToken,
      content
    )
    return (res as { event_id: string }).event_id
  }

  async uploadMedia(
    userToken: string,
    data: ArrayBuffer,
    mimeType: string,
    filename: string
  ): Promise<string> {
    const params = new URLSearchParams({ filename })
    const res = await fetch(
      `${this.baseUrl}/_matrix/media/v3/upload?${params}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${userToken}`,
          'Content-Type': mimeType
        },
        body: data
      }
    )
    if (!res.ok) throw new Error(`Media upload failed: ${res.status}`)
    const json = await res.json()
    return (json as { content_uri: string }).content_uri
  }

  async downloadMedia(mxcUri: string): Promise<{ data: ArrayBuffer; contentType: string }> {
    // SSRF guard: only allow mxc:// URIs
    if (!mxcUri.startsWith('mxc://')) {
      throw new Error('Invalid mxc URI: must start with mxc://')
    }
    const withoutScheme = mxcUri.slice('mxc://'.length)
    const [serverName, mediaId] = withoutScheme.split('/')
    if (!serverName || !mediaId) throw new Error('Invalid mxc URI format')

    // Authenticated media (MSC3916, Synapse ≥1.156): the legacy unauthenticated
    // /_matrix/media/v3/download 404s once media is auth-gated. The CS-API
    // /_matrix/client/v1/media/download endpoint requires an access token (which
    // we already send) and serves the same bytes.
    const url = `${this.baseUrl}/_matrix/client/v1/media/download/${encodeURIComponent(serverName)}/${encodeURIComponent(mediaId)}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.adminToken}` }
    })
    if (!res.ok) throw new Error(`Media download failed: ${res.status}`)
    const contentType = res.headers.get('Content-Type') ?? 'application/octet-stream'
    return { data: await res.arrayBuffer(), contentType }
  }

  async getJoinedRooms(userToken: string): Promise<string[]> {
    const res = await this.cs('GET', '/_matrix/client/v3/joined_rooms', userToken)
    return (res as { joined_rooms: string[] }).joined_rooms
  }

  async sendTyping(
    userToken: string,
    roomId: string,
    userId: string,
    typing: boolean
  ): Promise<void> {
    await this.cs(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`,
      userToken,
      { typing, timeout: typing ? 30000 : 0 }
    )
  }

  // Advance the user's read markers in a room to `eventId`, clearing its unread
  // notification count. Sets both `m.fully_read` (the fully-read marker that
  // persists the user's read position) and `m.read` (the read receipt that
  // resets the per-room notification_count which sync()/loadUnread sum into the
  // shell + sidebar badge). Posting both keeps the badge and the room's read
  // position consistent — opening a room therefore clears its unread.
  async setReadMarker(userToken: string, roomId: string, eventId: string): Promise<void> {
    await this.cs(
      'POST',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/read_markers`,
      userToken,
      { 'm.fully_read': eventId, 'm.read': eventId }
    )
  }

  // The admin bot's own Matrix user id (@localpart:server) — needed by
  // room-admin's make_room_admin fallback so the bot can be granted PL100.
  getAdminBotUserId(): string {
    return this.adminBotUserId
  }

  // FLOW-MSG-001 (TASK-009 lane B): room-admin state/alias primitives. All run
  // as the admin bot (never a per-user token) — room administration (create/
  // rename/archive/delete) is an admin action, not a member action.

  // Read one state event (state_key defaults to "", the room-global slot most
  // custom events — including org.gremion.room.archived — use). Returns the
  // parsed content, or null when the event is absent (404 — e.g. an active
  // room has no archive marker yet). A non-404 failure propagates.
  async getRoomState(roomId: string, eventType: string, stateKey = ''): Promise<unknown> {
    // LOW (round-1 deferred, r1-kernel-nav-roomsB2): every current caller
    // passes a constant eventType, so this was never exploitable in
    // practice — encoded anyway so a future caller can't turn an
    // unvalidated eventType into a path-injection primitive.
    const res = await fetch(
      `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}/${encodeURIComponent(stateKey)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${this.adminToken}` } }
    )
    if (res.status === 404) return null
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(
        `Matrix GET rooms/${roomId}/state/${eventType} → ${res.status}: ${(err as { error?: string }).error ?? ''}`
      )
    }
    return res.json()
  }

  // TASK-009 verifier FIX item 1: read one state event as a FULL event
  // (?format=event, supported since Synapse 1.124) so the caller can check
  // WHO sent it — the content-only read above cannot. Returns null on 404
  // (absent); a non-404 failure propagates. A body without a string `sender`
  // (a server that ignored format=event) comes back with sender '' so no
  // sender check can ever pass on it (fail closed).
  async getRoomStateEvent(
    roomId: string, eventType: string, stateKey = ''
  ): Promise<{ sender: string; content: unknown } | null> {
    const res = await fetch(
      `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}/${encodeURIComponent(stateKey)}?format=event`,
      { method: 'GET', headers: { Authorization: `Bearer ${this.adminToken}` } }
    )
    if (res.status === 404) return null
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(
        `Matrix GET rooms/${roomId}/state/${eventType}?format=event → ${res.status}: ${(err as { error?: string }).error ?? ''}`
      )
    }
    const body = (await res.json()) as { sender?: unknown; content?: unknown }
    return {
      sender: typeof body?.sender === 'string' ? body.sender : '',
      content: body?.content ?? null,
    }
  }

  // Write one state event as the admin bot.
  async setRoomState(
    roomId: string, eventType: string, stateKey: string, content: unknown
  ): Promise<void> {
    await this.cs(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}/${encodeURIComponent(stateKey)}`,
      this.adminToken,
      content
    )
  }

  // Point a canonical alias at roomId (idempotent overwrite — used both to
  // (re)assert #stura-<slug> on create and to mint the #stura-archiv-<slug>-
  // <timestamp> alias on archive).
  async putRoomAlias(alias: string, roomId: string): Promise<void> {
    await this.cs(
      'PUT',
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      this.adminToken,
      { room_id: roomId }
    )
  }

  // Remove a canonical alias. A 404 (already gone — a retry after a partial
  // failure, or the alias was never set) counts as success, mirroring
  // getRoomIdByAlias's 404-tolerant read.
  async deleteRoomAlias(alias: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${this.adminToken}` } }
    )
    if (res.status === 404 || res.ok) return
    const err = await res.json().catch(() => ({}))
    throw new Error(
      `Matrix DELETE directory/room/${alias} → ${res.status}: ${(err as { error?: string }).error ?? ''}`
    )
  }
}

// P2.1b T7 — per-tenant keyed client registry (Map<tenantId, instance>).
// The DEFAULT tenant builds from env byte-identically to the old process-wide
// singleton; non-default tenants build from their registry `services`
// (matrix_space url/adminTokenRef/adminBotUserId), falling back to env until
// P2.1c provisioning writes real per-tenant endpoints. Fail-closed: callers
// outside a runWithTenant scope throw (context.ts contract) — every route runs
// inside tenantResolveHandle and every worker tick inside forEachActiveTenant.
const _clientByTenant = new Map<string, MatrixClient>()

export function getMatrixClient(): MatrixClient {
  const ctx = getTenant()
  const existing = _clientByTenant.get(ctx.id)
  if (existing) return existing
  const svc = ctx.slug === 'default' ? undefined : ctx.services
  const client = new MatrixClient(
    svc?.matrixUrl ?? defaultTenantEnv('MATRIX_URL') ?? 'http://matrix:8008',
    svc?.synapseAdminTokenRef ? resolveSecret(svc.synapseAdminTokenRef) : (env.SYNAPSE_ADMIN_TOKEN ?? ''),
    svc?.synapseAdminBotUserId ?? env.SYNAPSE_ADMIN_BOT_USER_ID ?? ''
  )
  _clientByTenant.set(ctx.id, client)
  return client
}

/** Drop a tenant's cached client AND its token/inflight cache entries
 *  (tenant suspend/delete — wired by T8's evictTenantRuntime). */
export function evictMatrixClient(tenantId: string): void {
  _clientByTenant.delete(tenantId)
  const prefix = `${tenantId}|`
  for (const key of matrixTokenCache.keys()) {
    if (key.startsWith(prefix)) matrixTokenCache.delete(key)
  }
  for (const key of matrixTokenInflight.keys()) {
    if (key.startsWith(prefix)) matrixTokenInflight.delete(key)
  }
}

export const matrixClient = new Proxy({} as MatrixClient, {
  get(_target, prop) {
    return getMatrixClient()[prop as keyof MatrixClient]
  }
})

/** Test-only: clear the per-tenant client registry + token/inflight caches. */
export function __resetMatrixCachesForTests(): void {
  _clientByTenant.clear()
  matrixTokenCache.clear()
  matrixTokenInflight.clear()
}
