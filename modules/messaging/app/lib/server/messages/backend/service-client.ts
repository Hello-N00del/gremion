// gremion-ui/src/lib/server/messages/backend/service-client.ts
// HTTP ACL client: implements MessagesBackendPort over the messages-service leaf
// (MESSAGES_SERVICE_URL). Only active when MESSAGES_BACKEND=service (the HELD
// cutover); unused at runtime while the flag is OFF, but the matrix-token return
// op + resolveMatrixCreds soft-fail are pinned by service-client.test.ts against
// contracts/messages/openapi.messages-internal.json.
//
// The leaf is a THIN Matrix/LiveKit proxy: the kernel forwards the per-request
// user token (or Keycloak JWT) and the leaf performs the CS-API / LiveKit op AS
// that user. Every request carries x-internal-auth (INTERNAL_MESSAGES_SECRET) +
// x-tenant-id + x-tenant-slug (+ x-correlation-id). Mirrors the pattern in
// files/backend/service-client.ts.
//
// G-022: the auth.matrix-token op returns the raw minted Matrix token to the
// KERNEL caller (the route then scopes it to an HttpOnly cookie / mobile secure
// storage) — it never appears in a browser-facing JSON body. resolveMatrixCreds
// is SOFT: any leaf failure (or a missing session token) yields
// `{ userId: '', accessToken: '' }` without throwing, preserving the graceful
// degradation the video/token route depends on.

import type { RequestEvent } from '@sveltejs/kit'
import { getTenant } from '$lib/server/tenant/context'
import { getKeycloakJwt } from '../matrix-creds'
import { roomNameFromMatrixId, dmRoomName } from '../livekit-client'
import type {
  LivekitPort,
  MatrixClientPort,
  MatrixCreds,
  MatrixMessage,
  MessagesBackendPort,
  MintTokenOptions,
  SyncResponse,
  SynapseAdminPort,
} from './port'

/** Thrown when the messages leaf returns a non-2xx response. `status` mirrors the
 *  HTTP status so callers can map it to SvelteKit errors / Responses. */
export class MessagesServiceError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(`[messages-service-client] Leaf returned ${status}: ${message}`)
    this.name = 'MessagesServiceError'
    this.status = status
  }
}

export interface ServiceMessagesClientOptions {
  /** Optional correlation-id forwarded as x-correlation-id to the leaf. */
  correlationId?: string
  /** Optional injectable fetch implementation (for testing). Defaults to globalThis.fetch. */
  fetchImpl?: typeof globalThis.fetch
}

/**
 * Per-attempt leaf request budget. Exported so the retry guard in
 * service-client.test.ts drives the fake clock from the SAME value the
 * production timer uses - a private copy in the test silently stops
 * exercising the abort path the moment this number changes.
 */
export const REQUEST_TIMEOUT_MS = 5000

function resolveServiceUrl(): string {
  const url = process.env.MESSAGES_SERVICE_URL
  if (!url) {
    throw new Error(
      '[messages-service-client] MESSAGES_SERVICE_URL is not set. ' +
        "Configure it to point to the messages leaf service (e.g. 'http://messages-service:8080').",
    )
  }
  return url.replace(/\/$/, '')
}

function resolveSecret(): string {
  const secret = process.env.INTERNAL_MESSAGES_SECRET
  if (!secret) {
    throw new Error(
      '[messages-service-client] INTERNAL_MESSAGES_SECRET is not set. ' +
        'The messages leaf requires this shared secret in x-internal-auth.',
    )
  }
  return secret
}

// ── Matrix token cache (service mode, #389) ─────────────────────────────────
// Every messages API call exchanges the Keycloak JWT for a Synapse token before
// the actual op. Without a cache each call round-trips to the leaf, which does a
// fresh Synapse JWT /login → a single-user burst trips Synapse's rc_login
// rate-limit (429 → 502 cascade). The kernel therefore caches the exchanged
// token per session here, mirroring the in-process MatrixClient cache — so the
// leaf (and Synapse /login) is hit at most once per session/TTL. This is the
// caching the leaf's own comment ("the kernel caches the exchanged token on its
// side") assumes. Keyed per tenant so a token is never served across tenants.
interface CachedMatrixToken {
  matrixToken: string
  // Expire slightly before the Keycloak JWT does (a minted Matrix token lives up
  // to ~1 hour); bounded to 1 hour when the JWT carries no exp.
  expiresAt: number
}
const serviceMatrixTokenCache = new Map<string, CachedMatrixToken>()
// In-flight exchanges per cache key — collapses a cold-cache burst (N concurrent
// misses for the same session) into ONE leaf /login instead of N.
const serviceMatrixTokenInflight = new Map<string, Promise<string>>()

/** Decode a JWT payload without verifying the signature (server-side only). */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  try {
    const part = jwt.split('.')[1] ?? ''
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf-8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Drop a tenant's cached Matrix tokens + in-flight exchanges (tenant
 *  suspend/delete — registered as a T8 evictTenantRuntime hook, mirroring the
 *  in-process evictMatrixClient). */
export function evictServiceMatrixTokenCache(tenantId: string): void {
  const prefix = `${tenantId}|`
  for (const key of serviceMatrixTokenCache.keys()) {
    if (key.startsWith(prefix)) serviceMatrixTokenCache.delete(key)
  }
  for (const key of serviceMatrixTokenInflight.keys()) {
    if (key.startsWith(prefix)) serviceMatrixTokenInflight.delete(key)
  }
}

/** Evict every cached service-mode Matrix token equal to `token`. */
function evictServiceMatrixToken(token: string): void {
  if (!token) return
  for (const [key, entry] of serviceMatrixTokenCache) {
    if (entry.matrixToken === token) serviceMatrixTokenCache.delete(key)
  }
}

/** The per-request user Matrix token a leaf call body carries, if any. */
function userTokenOf(body: unknown): string {
  const b = body as { userToken?: unknown; join?: { userToken?: unknown } } | null | undefined
  const t = b?.userToken ?? b?.join?.userToken
  return typeof t === 'string' ? t : ''
}

/** Test-only: clear the service-mode Matrix token cache + in-flight map. */
export function __resetServiceMatrixTokenCacheForTests(): void {
  serviceMatrixTokenCache.clear()
  serviceMatrixTokenInflight.clear()
}

/** The HTTP twin of the kernel MatrixClient — each method POSTs the equivalent
 *  op to the leaf. Only getMatrixToken (the matrix-token op) is pinned by a test;
 *  the remaining fine-grained ops are wired for the HELD cutover. */
class ServiceMatrixClient implements MatrixClientPort {
  constructor(private readonly leaf: ServiceMessagesClient) {}

  async getMatrixToken(keycloakJwt: string, deviceId?: string): Promise<string> {
    const payload = decodeJwtPayload(keycloakJwt)
    const sub = (payload.sub as string | undefined) ?? keycloakJwt.slice(-20)
    const keycloakExp = typeof payload.exp === 'number' ? payload.exp * 1000 : 0
    const tenantId = getTenant().id
    const subKey = deviceId ? `${sub}:${deviceId}` : sub
    const cacheKey = `${tenantId}|${subKey}`

    // Fresh cached token — a valid Matrix token is usable even once the Keycloak
    // JWT has expired (the Matrix token has its own lifetime).
    const cached = serviceMatrixTokenCache.get(cacheKey)
    if (cached && Date.now() < cached.expiresAt) return cached.matrixToken

    // Collapse concurrent cold-cache misses into one leaf /login.
    const inflight = serviceMatrixTokenInflight.get(cacheKey)
    if (inflight) return inflight

    // No cached token — a fresh exchange needs a still-valid Keycloak JWT.
    if (keycloakExp > 0 && Date.now() >= keycloakExp) {
      throw new Error('Keycloak JWT is expired — session refresh required')
    }

    const loginPromise = this.leaf
      .leafJson<{ matrixToken: string }>('auth.matrix-token', '/api/v1/auth/matrix-token', {
        keycloakJwt,
        deviceId,
      })
      .then((res) => {
        const matrixToken = res.matrixToken
        // Fixed 1 h TTL from the exchange, NOT tied to the Keycloak exp: every
        // access-token rotation used to re-exchange through the leaf (Synapse's
        // per-address login limit answers 429, and each login creates a device).
        // Safe: requests from an ended session stop at the authGuard
        // (session.error), Bearer callers have their JWT exp verified in hooks, and
        // web callers never see the Matrix token.
        serviceMatrixTokenCache.set(cacheKey, { matrixToken, expiresAt: Date.now() + 3_600_000 })
        return matrixToken
      })
      .finally(() => {
        serviceMatrixTokenInflight.delete(cacheKey)
      })

    serviceMatrixTokenInflight.set(cacheKey, loginPromise)
    return loginPromise
  }

  sync(userToken: string, since?: string): Promise<SyncResponse> {
    return this.leaf.leafJson('messages.sync', '/api/v1/messages/sync', { userToken, since }, true)
  }

  async getJoinedRooms(userToken: string): Promise<string[]> {
    const res = await this.leaf.leafJson<{ rooms: string[] }>(
      'messages.rooms',
      '/api/v1/messages/rooms',
      { userToken },
      true,
    )
    return res.rooms ?? []
  }

  async unreadMessageCountsByRoom(userToken: string): Promise<Map<string, number>> {
    const res = await this.leaf.leafJson<{ counts: Record<string, number> }>(
      'messages.rooms',
      '/api/v1/messages/rooms',
      { userToken, unread: true },
      true,
    )
    return new Map(Object.entries(res.counts ?? {}))
  }

  getMessages(userToken: string, roomId: string, from?: string): Promise<{ messages: MatrixMessage[]; end: string }> {
    return this.leaf.leafJson('messages.list', '/api/v1/messages/list', { userToken, roomId, from }, true)
  }

  async sendMessage(userToken: string, roomId: string, content: { msgtype: string; body: string; url?: string }): Promise<string> {
    const res = await this.leaf.leafJson<{ eventId: string }>(
      'messages.send',
      '/api/v1/messages/send',
      { userToken, roomId, content },
    )
    return res.eventId
  }

  async setReadMarker(userToken: string, roomId: string, eventId: string): Promise<void> {
    await this.leaf.leafJson('messages.read', '/api/v1/messages/read', { userToken, roomId, eventId })
  }

  async sendTyping(userToken: string, roomId: string, userId: string, typing: boolean): Promise<void> {
    await this.leaf.leafJson('messages.typing', '/api/v1/messages/typing', { userToken, roomId, userId, typing })
  }

  async uploadMedia(userToken: string, data: ArrayBuffer, mimeType: string, filename: string): Promise<string> {
    const res = await this.leaf.leafJson<{ mxc: string }>(
      'messages.media.upload',
      '/api/v1/messages/media/upload',
      { userToken, mimeType, filename, data: Buffer.from(data).toString('base64') },
    )
    return res.mxc
  }

  async downloadMedia(mxcUri: string): Promise<{ data: ArrayBuffer; contentType: string }> {
    const res = await this.leaf.leafJson<{ data: string; contentType: string }>(
      'messages.media.download',
      '/api/v1/messages/media/download',
      { mxcUri },
      true,
    )
    // Exact-size the decode: a small (<4096 byte) payload is allocated from Node's
    // shared 8192-byte Buffer pool, so `.buffer` would return the WHOLE pool
    // (garbage prefix at byteOffset + trailing pool memory from other requests).
    // Slice to byteOffset/byteLength — matching the leaf's upload decode and the
    // inprocess MatrixClient.downloadMedia exact-sized `await res.arrayBuffer()`.
    const buf = Buffer.from(res.data, 'base64')
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), contentType: res.contentType }
  }

  async createRoom(name: string, topic: string, aliasLocalpart?: string): Promise<string> {
    const res = await this.leaf.leafJson<{ roomId: string }>(
      'video.meeting-room',
      '/api/v1/video/meeting-room',
      { name, topic, aliasLocalpart },
    )
    return res.roomId
  }

  async inviteUser(roomId: string, userId: string): Promise<void> {
    await this.leaf.leafJson('video.meeting-room', '/api/v1/video/meeting-room', { invite: { roomId, userId } })
  }

  async joinRoom(userToken: string, roomIdOrAlias: string): Promise<void> {
    await this.leaf.leafJson('video.meeting-room', '/api/v1/video/meeting-room', { join: { userToken, roomIdOrAlias } })
  }
}

export class ServiceMessagesClient implements MessagesBackendPort {
  readonly kind = 'service' as const

  private readonly correlationId: string | undefined
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(opts: ServiceMessagesClientOptions = {}) {
    this.correlationId = opts.correlationId
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  private buildHeaders(): Record<string, string> {
    const secret = resolveSecret()
    const tenant = getTenant()
    const headers: Record<string, string> = {
      'x-internal-auth': secret,
      'x-tenant-id': tenant.id,
      'x-tenant-slug': tenant.slug,
      'content-type': 'application/json',
    }
    if (this.correlationId) headers['x-correlation-id'] = this.correlationId
    return headers
  }

  /** JSON leaf call. Serializes `body` as JSON, parses the JSON response; throws
   *  MessagesServiceError on non-2xx.
   *
   *  RETRY (bounded, opt-in): a caller that declares `idempotent` gets ONE extra
   *  attempt after a TRANSPORT failure (ECONNRESET / connect refused / DNS / this
   *  method's own 5 s abort — each attempt has its OWN AbortController, so the
   *  abort case really is retryable) — the same one-retry posture every sibling leaf ACL
   *  already has (board/calendar/content/finance/newsletter/vault/files/elections),
   *  which this client alone lacked, so a single dropped connection during a
   *  rolling leaf restart surfaced as a 502 on a pure READ. Two hard boundaries:
   *    - a non-2xx RESPONSE is never retried. It is the leaf's answer, not a lost
   *      connection, and replaying it doubles load on an already-failing leaf.
   *    - a WRITE is never retried. Every op here is an HTTP POST over a transport
   *      with no idempotency key, so a blind replay can duplicate a Matrix event;
   *      the read/write split is therefore carried by this explicit flag, not by
   *      the HTTP verb. `idempotent` defaults to FALSE — a new op is a write until
   *      its author says otherwise.
   *  Bounded means exactly one extra attempt: at most two fetches, never a loop.
   *
   *  #449(b): every caller folds a MessagesServiceError into a generic 502
   *  (`/api/messages/rooms` → "Matrix authentication failed"), so the leaf's own
   *  status and body were the only evidence of WHY — and they were dropped here.
   *  Both failure shapes are now logged before the throw: a non-2xx response
   *  (status + truncated body) and a transport failure (connect refused / DNS /
   *  the AbortError this method's own 5 s timeout raises), which never had a
   *  status at all. `op` is part of the record so a 502 is attributable to the
   *  exact leaf op rather than just a path. BOTH attempts are logged, tagged
   *  `attempt 1`/`attempt 2`, so the record and the thrown error cannot
   *  disagree. Same console.error seam the sibling backend/resolve.ts uses; the
   *  request body is NEVER logged (it carries userToken/keycloakJwt). */
  async leafJson<T>(op: string, path: string, body: unknown, idempotent = false): Promise<T> {
    const url = `${resolveServiceUrl()}${path}`
    // Resolved BEFORE the timer/try below: buildHeaders throws on missing
    // INTERNAL_MESSAGES_SECRET (fail-closed config error), and that must not be
    // reported as a leaf transport failure.
    const headers = this.buildHeaders()
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    // One attempt = its OWN AbortController and its own 5 s budget, created
    // here rather than once for the call. Sharing one controller meant a first
    // attempt that died on the 5 s abort handed the retry an ALREADY-ABORTED
    // signal, and fetch rejects a pre-aborted signal immediately — so "this
    // method's own 5 s abort", one of the three transport classes the retry
    // advertises, could never actually recover. The cost is that an idempotent
    // READ whose first attempt times out can now take up to 2 x 5 s; that is
    // the point of a timeout retry, and it is reads only.
    const attempt = async (): Promise<{ res: Response; releaseBudget: () => void }> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers,
          body: payload,
          signal: controller.signal,
        })
        // The timer stays armed until the BODY is consumed — the 5 s budget
        // covered headers + body before this refactor and still does.
        return { res, releaseBudget: () => clearTimeout(timer) }
      } catch (err) {
        clearTimeout(timer)
        throw err
      }
    }
    const logTransportFailure = (attemptNo: 1 | 2, err: unknown) => {
      console.error(
        `[messages-service-client] leaf op ${op} (POST ${path}) transport failure (attempt ${attemptNo}):`,
        err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      )
    }

    let started: { res: Response; releaseBudget: () => void }
    try {
      started = await attempt()
    } catch (err) {
      logTransportFailure(1, err)
      // Bounded retry: ONE extra attempt, transport failures only, reads only.
      if (!idempotent) throw err
      try {
        started = await attempt()
      } catch (retryErr) {
        // The retry's own failure is logged too. Without this the record named
        // the FIRST error while the caller's 502 was attributed to the second.
        logTransportFailure(2, retryErr)
        throw retryErr
      }
    }
    const { res, releaseBudget } = started
    try {
      if (!res.ok) {
        const msg = await res.text().catch(() => `HTTP ${res.status}`)
        // Log a longer slice than the thrown message carries — the leaf's error
        // body is the diagnostic, and the throw is truncated to 200 chars to keep
        // it presentable in an error page.
        console.error(
          `[messages-service-client] leaf op ${op} (POST ${path}) returned ${res.status}:`,
          msg.slice(0, 500),
        )
        // Synapse invalidated the user token the leaf call carried (the leaf
        // flags it with a structured errcode): drop it so the next request
        // re-exchanges instead of failing until the 1 h TTL.
        let errcode: unknown
        try { errcode = (JSON.parse(msg) as { errcode?: unknown }).errcode } catch { /* non-JSON */ }
        if (errcode === 'M_UNKNOWN_TOKEN') evictServiceMatrixToken(userTokenOf(body))
        throw new MessagesServiceError(res.status, msg.slice(0, 200))
      }
      return (await res.json()) as T
    } finally {
      releaseBudget()
    }
  }

  matrix(): MatrixClientPort {
    return new ServiceMatrixClient(this)
  }

  synapse(): SynapseAdminPort {
    return {
      forceJoinRoom: async (roomId: string, userId: string) => {
        await this.leafJson('video.meeting-room', '/api/v1/video/meeting-room', { forceJoin: { roomId, userId } })
      },
      // #370: the admin all-rooms list, forwarded to the video.meeting-room admin
      // multiplex ({ listRooms: true } → { roomIds }). Keeps SYNAPSE_ADMIN_TOKEN in
      // the leaf — the kernel routes never touch the admin credential.
      listAllRoomIds: async () => {
        const res = await this.leafJson<{ roomIds?: string[] }>(
          'video.meeting-room',
          '/api/v1/video/meeting-room',
          { listRooms: true },
        )
        return res.roomIds ?? []
      },
      // G-022 admin isolation: the device-delete admin op is forwarded to the leaf
      // (which holds SYNAPSE_ADMIN_TOKEN + SYNAPSE_SERVER_NAME) — the kernel forwards
      // only the caller's localpart + deviceId, never the admin credential. The leaf
      // forms @{localpart}:{SYNAPSE_SERVER_NAME} and DELETEs the device.
      deleteDevice: async (localpart: string, deviceId: string) => {
        await this.leafJson('auth.matrix-device', '/api/v1/auth/matrix-device', { localpart, deviceId })
      },
      // #257-1 room-membership gate: forwarded to the video.meeting-room membership
      // multiplex ({ isMember: { roomId, userId } } → { isMember: boolean }). Keeps
      // SYNAPSE_ADMIN_TOKEN in the leaf — the kernel forwards only the room id +
      // user id. Fails CLOSED like the in-process SynapseAdmin.isRoomMember: a leaf
      // error (or a non-boolean payload) yields false so the video/token route never
      // mints a room-pinned token on an unverifiable membership.
      isRoomMember: async (roomId: string, userId: string) => {
        try {
          const res = await this.leafJson<{ isMember?: boolean }>(
            'video.meeting-room',
            '/api/v1/video/meeting-room',
            { isMember: { roomId, userId } },
          )
          return res.isMember === true
        } catch {
          return false
        }
      },
    }
  }

  livekit(): LivekitPort {
    return {
      // roomName helpers are PURE (no secrets) — computed kernel-side identically
      // in both modes; only mintToken (which touches LiveKit keys) goes to the leaf.
      roomNameFromMatrixId,
      dmRoomName,
      mintToken: async (opts: MintTokenOptions) => {
        const res = await this.leafJson<{ token: string }>('video.token', '/api/v1/video/token', opts)
        return res.token
      },
    }
  }

  async resolveMatrixCreds(event: RequestEvent): Promise<MatrixCreds> {
    // SOFT: mirror the kernel matrix-creds contract — any failure (missing session
    // token, or a leaf error) degrades to empty creds so the video/token route can
    // still mint a LiveKit token and let element-call prompt for login.
    try {
      const jwt = await getKeycloakJwt(event)
      const res = await this.leafJson<{ matrixToken?: string; matrixUserId?: string }>(
        'auth.matrix-token',
        '/api/v1/auth/matrix-token',
        { keycloakJwt: jwt },
      )
      if (res.matrixUserId && res.matrixToken) {
        return { userId: res.matrixUserId, accessToken: res.matrixToken }
      }
    } catch {
      // Fall through — Matrix creds unavailable, caller decides how to degrade.
    }
    return { userId: '', accessToken: '' }
  }
}
