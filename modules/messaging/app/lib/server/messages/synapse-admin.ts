import { env } from '$env/dynamic/private'
import { getTenant } from '$lib/server/tenant/context'
import { serviceEnv } from '$lib/server/env/service-env'
import { resolveSecret } from '$lib/server/tenant/secrets'

interface SynapseErrorBody {
  errcode?: string
  error?: string
}

class SynapseError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly errcode: string
  ) {
    super(message)
    this.name = 'SynapseError'
  }
}

class SynapseAdminClient {
  private readonly baseUrl: string
  private readonly adminToken: string
  private readonly serverName: string

  constructor(baseUrl: string, adminToken: string, serverName: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.adminToken = adminToken
    this.serverName = serverName
  }

  private async apiRequest(
    method: string,
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.adminToken}`,
        'Content-Type': 'application/json'
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    if (!res.ok) {
      let errBody: SynapseErrorBody = {}
      try {
        errBody = await res.json()
      } catch {
        // ignore parse error
      }
      throw new SynapseError(
        errBody.error ?? `Synapse ${method} ${path} → ${res.status}`,
        res.status,
        errBody.errcode ?? 'M_UNKNOWN'
      )
    }
    if (res.status === 204) return null
    return res.json()
  }

  // Validate that the configured SYNAPSE_ADMIN_TOKEN is accepted by a Synapse
  // admin endpoint. Used by the setup health check to surface a bad/empty token
  // distinctly from mere reachability. Returns false on any auth/transport
  // failure rather than throwing, so the caller can treat it as a boolean probe.
  // GET /_synapse/admin/v1/rooms?limit=1 requires a valid admin token.
  async validateCredentials(timeoutMs = 3000): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const res = await fetch(`${this.baseUrl}/_synapse/admin/v1/rooms?limit=1`, {
        headers: { Authorization: `Bearer ${this.adminToken}` },
        signal: controller.signal
      })
      clearTimeout(timer)
      return res.ok
    } catch {
      return false
    }
  }

  // Creates or updates a Matrix user (idempotent — safe to call on re-provisioning).
  // PUT /_synapse/admin/v2/users/@{localpart}:{serverName}
  async createUser(localpart: string, displayName: string): Promise<void> {
    const userId = `@${localpart}:${this.serverName}`
    await this.apiRequest('PUT', `/_synapse/admin/v2/users/${encodeURIComponent(userId)}`, {
      displayname: displayName,
      deactivated: false
    })
  }

  // #257-1: returns the list of member user-ids in roomId (joined + invited),
  // via the Synapse Admin API. Used to authorize LiveKit publish-token minting
  // so a caller can only obtain a token for a room it actually belongs to.
  // GET /_synapse/admin/v1/rooms/{roomId}/members → { members: string[], total }
  async getRoomMembers(roomId: string): Promise<string[]> {
    const res = await this.apiRequest(
      'GET',
      `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/members`
    )
    return (res as { members?: string[] }).members ?? []
  }

  // #257-1: true iff userId is a member of roomId. Fails CLOSED — any admin-API
  // error (room not found, transport failure) yields false so a publish token is
  // never minted on an unverifiable membership.
  async isRoomMember(roomId: string, userId: string): Promise<boolean> {
    try {
      const members = await this.getRoomMembers(roomId)
      return members.includes(userId)
    } catch {
      return false
    }
  }

  // Deletes the caller's OWN Synapse device via the admin API. Used during mobile
  // OLM key recovery (the DELETE /api/auth/matrix-device route). Preserves that
  // route's EXACT semantics — on a non-2xx it throws with the Synapse error body's
  // `error` (or `Synapse <status>`), which the route maps to a 502; a network error
  // propagates as-is. userId = @{localpart}:{serverName} (this.serverName is the
  // per-tenant server name, byte-identical to the route's default-tenant
  // serviceEnv('SYNAPSE_SERVER_NAME') resolution). Deliberately does NOT go
  // through apiRequest() so the thrown message matches the pre-seam route verbatim.
  // DELETE /_synapse/admin/v2/users/{userId}/devices/{deviceId}
  async deleteDevice(localpart: string, deviceId: string): Promise<void> {
    const userId = `@${localpart}:${this.serverName}`
    const res = await fetch(
      `${this.baseUrl}/_synapse/admin/v2/users/${encodeURIComponent(userId)}/devices/${encodeURIComponent(deviceId)}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      }
    )
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(err.error ?? `Synapse ${res.status}`)
    }
  }

  // #370: all server room ids (GET /_synapse/admin/v1/rooms?limit=100). Folds the
  // matrix-token + messages/rooms routes' inline admin fetch behind the seam so
  // SYNAPSE_ADMIN_TOKEN (+ MATRIX_URL) stay in the backend — and it uses THIS
  // tenant's baseUrl/adminToken rather than the routes' default-tenant env. Used
  // to auto-join a fresh user to every room on first login. Degrades to [] on any
  // failure (mirrors the routes' prior `if (!res.ok) return []`, extended to also
  // swallow transport errors so a Synapse hiccup can never 500 the room list).
  async listAllRoomIds(): Promise<string[]> {
    try {
      const res = await this.apiRequest('GET', '/_synapse/admin/v1/rooms?limit=100')
      return ((res as { rooms?: Array<{ room_id: string }> }).rooms ?? []).map((r) => r.room_id)
    } catch {
      return []
    }
  }

  // Force-joins userId to roomId using the Admin API.
  // POST /_synapse/admin/v1/join/{roomId}
  async forceJoinRoom(roomId: string, userId: string): Promise<void> {
    try {
      await this.apiRequest('POST', `/_synapse/admin/v1/join/${encodeURIComponent(roomId)}`, {
        user_id: userId
      })
    } catch (err) {
      // Idempotent: Synapse errors if the user is already joined. Re-provisioning
      // (and reseeding onto leftover rooms) must treat "already a member" as success.
      if (err instanceof Error && /already in the room/i.test(err.message)) return
      throw err
    }
  }

  // Deactivates a Matrix user (does not delete messages).
  // PUT /_synapse/admin/v2/users/{userId}  body: { deactivated: true }
  async deactivateUser(userId: string): Promise<void> {
    await this.apiRequest('PUT', `/_synapse/admin/v2/users/${encodeURIComponent(userId)}`, {
      deactivated: true
    })
  }

  // Get a short-lived Matrix access token for any user via admin API.
  // POST /_synapse/admin/v1/users/{userId}/login
  async getUserLoginToken(localpart: string): Promise<string> {
    const userId = `@${localpart}:${this.serverName}`
    const res = await this.apiRequest(
      'POST',
      `/_synapse/admin/v1/users/${encodeURIComponent(userId)}/login`,
      {}
    )
    return (res as { access_token: string }).access_token
  }

  // Kicks userId from roomId.
  // POST /_matrix/client/v3/rooms/{roomId}/kick  as admin bot
  async kickFromRoom(roomId: string, userId: string, reason = ''): Promise<void> {
    await this.apiRequest('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/kick`, {
      user_id: userId,
      reason
    })
  }

  // Deletes a room: blocks re-joins and purges its history.
  // DELETE /_synapse/admin/v1/rooms/{roomId}
  async deleteRoom(roomId: string): Promise<void> {
    await this.apiRequest('DELETE', `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}`, {
      block: true,
      purge: true
    })
  }

  // FLOW-MSG-001 (TASK-009 lane B): room-admin overview + archive-fallback primitives.

  // Room details (name, joined_members, canonical_alias, …) for the admin
  // overview. Returns null on 404 (room purged/never existed) rather than
  // throwing, mirroring MatrixClient.getRoomIdByAlias's 404-tolerant read.
  // GET /_synapse/admin/v1/rooms/{roomId}
  async getRoomDetails(roomId: string): Promise<Record<string, unknown> | null> {
    try {
      return (await this.apiRequest(
        'GET', `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}`
      )) as Record<string, unknown>
    } catch (err) {
      if (err instanceof SynapseError && err.status === 404) return null
      throw err
    }
  }

  // Paginated room search (used by the overview to list archived rooms via
  // their #stura-archiv-<slug>-<timestamp> alias search term). Follows
  // `next_batch` until Synapse stops returning one, accumulating every page's
  // `rooms` into a single array.
  // GET /_synapse/admin/v1/rooms?search_term={term}&from={from}
  async searchRooms(term: string): Promise<Array<Record<string, unknown>>> {
    const rooms: Array<Record<string, unknown>> = []
    let from: number | undefined
    for (;;) {
      const params = new URLSearchParams({ search_term: term })
      if (from !== undefined) params.set('from', String(from))
      const res = (await this.apiRequest(
        'GET', `/_synapse/admin/v1/rooms?${params}`
      )) as { rooms?: Array<Record<string, unknown>>; next_batch?: number }
      rooms.push(...(res.rooms ?? []))
      if (res.next_batch === undefined) break
      from = res.next_batch
    }
    return rooms
  }

  // FLOW-MSG-001 (TASK-009 fu1 defect 1): full paginated room listing, no
  // search_term. Synapse's search_term only filters by "room name, canonical
  // alias and room id" (element-hq synapse docs/admin_api/rooms.md) — an
  // archived room whose only alias lives in the room directory (never made
  // canonical) is invisible to it, so findArchivedRooms can no longer use
  // searchRooms() to find them (see that method above; kept for its other
  // callers/tests, not deleted). This instead scans every room on the
  // server, unfiltered, so the caller can apply its OWN trust boundary
  // (creator === admin bot) rather than relying on Synapse's text search.
  // Follows `next_batch` until Synapse stops returning one — no silent
  // 100-room cap, matching searchRooms' own pagination.
  // GET /_synapse/admin/v1/rooms[?from={from}]
  async listRooms(): Promise<
    Array<{ room_id: string; creator?: string; name?: string; canonical_alias?: string | null }>
  > {
    const rooms: Array<{ room_id: string; creator?: string; name?: string; canonical_alias?: string | null }> = []
    let from: number | undefined
    for (;;) {
      const params = new URLSearchParams()
      if (from !== undefined) params.set('from', String(from))
      const qs = params.toString()
      const res = (await this.apiRequest(
        'GET', `/_synapse/admin/v1/rooms${qs ? `?${qs}` : ''}`
      )) as {
        rooms?: Array<{ room_id: string; creator?: string; name?: string; canonical_alias?: string | null }>
        next_batch?: number
      }
      rooms.push(...(res.rooms ?? []))
      // LOW (TASK-009 fu1 round 2 verifier): real Synapse omits next_batch on
      // the last page, so this cannot loop forever against Synapse itself —
      // but nothing guarded against a misbehaving proxy/homeserver echoing
      // back a non-numeric or non-advancing next_batch, which would spin this
      // loop forever inside a single overview request. Stop paginating the
      // moment next_batch isn't a real forward step.
      if (typeof res.next_batch !== 'number' || res.next_batch <= (from ?? 0)) break
      from = res.next_batch
    }
    return rooms
  }

  // Grants userId (the admin bot, in the archive/rename fallback path) room-
  // admin power (PL100) in roomId. Used when the bot created a room but is no
  // longer PL100 (a legacy room, a demo seed) and a rename/archive would
  // otherwise be rejected with M_FORBIDDEN.
  // POST /_synapse/admin/v1/rooms/{roomId}/make_room_admin
  async makeRoomAdmin(roomId: string, userId: string): Promise<void> {
    await this.apiRequest(
      'POST', `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/make_room_admin`,
      { user_id: userId }
    )
  }
}

// P2.1b T7 — per-tenant keyed admin-client registry (Map<tenantId, instance>),
// lazily instantiated on first access per tenant. The DEFAULT tenant builds
// from env byte-identically to the old singleton; non-default tenants build
// from their registry `services` (matrix_space url/adminTokenRef/serverName)
// with env fallback until P2.1c provisioning. Fail-closed outside ALS.
const _adminByTenant = new Map<string, SynapseAdminClient>()

export function getSynapseAdmin(): SynapseAdminClient {
  const ctx = getTenant()
  const existing = _adminByTenant.get(ctx.id)
  if (existing) return existing
  const svc = ctx.services
  const client = new SynapseAdminClient(
    svc?.matrixUrl ?? serviceEnv('MATRIX_URL') ?? 'http://matrix:8008',
    svc?.synapseAdminTokenRef ? resolveSecret(svc.synapseAdminTokenRef) : (env.SYNAPSE_ADMIN_TOKEN ?? ''),
    svc?.synapseServerName ?? serviceEnv('SYNAPSE_SERVER_NAME') ?? 'localhost'
  )
  _adminByTenant.set(ctx.id, client)
  return client
}

/** Drop a tenant's cached Synapse admin client (T8 evictTenantRuntime). */
export function evictSynapseAdmin(tenantId: string): void {
  _adminByTenant.delete(tenantId)
}

/** Test-only: clear the per-tenant admin-client registry. */
export function __resetSynapseAdminForTests(): void {
  _adminByTenant.clear()
}

export const synapseAdmin = new Proxy({} as SynapseAdminClient, {
  get(_target, prop) {
    return getSynapseAdmin()[prop as keyof SynapseAdminClient]
  }
})
