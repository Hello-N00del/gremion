// services/messages/src/matrix/synapse-admin.ts
// Leaf-side Synapse Admin API forwarder. Standalone (node built-ins + global
// fetch): the leaf holds the server admin token + server name (its own env) and
// performs admin ops. Forwarding building block for the MESSAGES_BACKEND=service
// cutover.
//
// Mirrors the kernel gremion-ui/src/lib/server/messages/synapse-admin.ts admin
// calls the messages+video routes reach through the seam (forceJoinRoom,
// deleteDevice, #370 listAllRoomIds), plus the setup-health credential probe
// (validateCredentials). G-022: SYNAPSE_ADMIN_TOKEN + SYNAPSE_SERVER_NAME live
// HERE (the leaf), never in the kernel routes — the kernel forwards only the
// caller's localpart/deviceId and the leaf forms @{localpart}:{serverName}.

export interface SynapseAdminOptions {
  baseUrl: string
  adminToken: string
  /** Synapse server name — used to form @{localpart}:{serverName} (deleteDevice). */
  serverName?: string
}

export interface SynapseLeafAdmin {
  /** Force-join a user to a room via the Admin API (idempotent). */
  forceJoinRoom(roomId: string, userId: string): Promise<void>
  /** Delete the caller's OWN Synapse device (forms @{localpart}:{serverName}). */
  deleteDevice(localpart: string, deviceId: string): Promise<void>
  /** #370: all server room ids via the Admin API (rooms auto-join source). */
  listAllRoomIds(): Promise<string[]>
  /** True iff the configured admin token is accepted by a Synapse admin endpoint. */
  validateCredentials(timeoutMs?: number): Promise<boolean>
}

export function createSynapseAdmin(opts: SynapseAdminOptions): SynapseLeafAdmin {
  const baseUrl = opts.baseUrl.replace(/\/$/, '')
  const serverName = opts.serverName ?? 'localhost'

  async function apiRequest(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${opts.adminToken}`, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(`Synapse ${method} ${path} → ${res.status}: ${err.error ?? ''}`)
    }
    if (res.status === 204) return null
    return res.json()
  }

  async function forceJoinRoom(roomId: string, userId: string): Promise<void> {
    try {
      await apiRequest('POST', `/_synapse/admin/v1/join/${encodeURIComponent(roomId)}`, { user_id: userId })
    } catch (err) {
      // Idempotent: Synapse errors if the user is already joined.
      if (err instanceof Error && /already in the room/i.test(err.message)) return
      throw err
    }
  }

  // Mirrors the kernel SynapseAdminClient.deleteDevice: preserves the pre-seam
  // route's exact error semantics (throws with the Synapse error body's `error`,
  // which the kernel route maps to a 502). Deliberately does NOT go through
  // apiRequest() so the thrown message matches verbatim.
  async function deleteDevice(localpart: string, deviceId: string): Promise<void> {
    const userId = `@${localpart}:${serverName}`
    const res = await fetch(
      `${baseUrl}/_synapse/admin/v2/users/${encodeURIComponent(userId)}/devices/${encodeURIComponent(deviceId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${opts.adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    )
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(err.error ?? `Synapse ${res.status}`)
    }
  }

  // #370: all server room ids (GET /_synapse/admin/v1/rooms?limit=100). Mirrors
  // the pre-seam route's direct admin fetch, now behind the port so
  // SYNAPSE_ADMIN_TOKEN stays leaf-side. Degrades to [] on any failure.
  async function listAllRoomIds(): Promise<string[]> {
    try {
      const res = (await apiRequest('GET', '/_synapse/admin/v1/rooms?limit=100')) as {
        rooms?: Array<{ room_id: string }>
      }
      return (res.rooms ?? []).map((r) => r.room_id)
    } catch {
      return []
    }
  }

  async function validateCredentials(timeoutMs = 3000): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const res = await fetch(`${baseUrl}/_synapse/admin/v1/rooms?limit=1`, {
        headers: { Authorization: `Bearer ${opts.adminToken}` },
        signal: controller.signal,
      })
      clearTimeout(timer)
      return res.ok
    } catch {
      return false
    }
  }

  return { forceJoinRoom, deleteDevice, listAllRoomIds, validateCredentials }
}
