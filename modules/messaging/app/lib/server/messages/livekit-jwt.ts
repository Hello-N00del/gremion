import { serviceEnv } from '$lib/server/env/service-env'
import { getTenant } from '$lib/server/tenant/context'
import { getMatrixClient } from './matrix-client'
import { getSynapseAdmin } from './synapse-admin'
import { livekitRoomNamespace, livekitServerUrl, mintToken, roomNameFromMatrixId } from './livekit-client'

export interface OpenIDToken {
  access_token: string
  token_type: string
  matrix_server_name?: string
}

export interface SfuRequest {
  room: string
  openid_token: OpenIDToken
  device_id?: string
}

export interface SfuResponse {
  url: string
  jwt: string
}

// P2.1b T7: the homeserver the OpenID token is validated against resolves per
// tenant (default = env, byte-identical; others = registry services.matrixUrl
// with env fallback until P2.1c provisioning).
function matrixUrl(): string {
  const ctx = getTenant()
  const svc = ctx.services
  return (svc?.matrixUrl ?? serviceEnv('MATRIX_URL') ?? 'http://matrix:8008').replace(/\/$/, '')
}

/**
 * Validates a Matrix OpenID token via Synapse's federation userinfo endpoint.
 * Returns the Matrix user ID (sub) or throws if invalid.
 */
export async function validateOpenIDToken(token: string): Promise<string> {
  const url = `${matrixUrl()}/_matrix/federation/v1/openid/userinfo?access_token=${encodeURIComponent(token)}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`OpenID token validation failed: ${res.status}`)
  }
  const data = (await res.json()) as { sub?: string }
  if (!data.sub) throw new Error('OpenID userinfo missing sub claim')
  return data.sub
}

/**
 * Derives a LiveKit room name from a Matrix room identifier.
 * Handles room IDs (!abc:server), aliases (#name:server), and bare names.
 * P2.1b T7 (D-LIVEKIT): every branch carries the current tenant's namespace
 * prefix — '' for the default tenant (byte-identical), `t.<slug>.` otherwise.
 * A bare name already carrying the OWN tenant's prefix is not double-prefixed.
 */
export function livekitRoomName(matrixRoom: string): string {
  if (matrixRoom.startsWith('!')) {
    return roomNameFromMatrixId(matrixRoom) // namespaced inside
  }
  const ns = livekitRoomNamespace()
  if (matrixRoom.startsWith('#')) {
    // Extract localpart from alias: #localpart:server → localpart
    const localpart = matrixRoom.slice(1).split(':')[0]
    return `${ns}${localpart}`
  }
  if (ns !== '' && matrixRoom.startsWith(ns)) return matrixRoom
  return `${ns}${matrixRoom}`
}

/**
 * #257-1: thrown when the validated caller is not a member of the requested
 * Matrix room. Callers map this to a 403 (vs. 502 for transport/mint errors).
 */
export class RoomMembershipError extends Error {
  constructor(message = 'caller is not a member of the requested room') {
    super(message)
    this.name = 'RoomMembershipError'
  }
}

/**
 * #257-1: resolve the caller-supplied `body.room` to a canonical Matrix room id
 * so membership can be checked against Synapse. Room IDs (`!id:server`) are used
 * verbatim; aliases (`#alias:server`) are resolved via the directory; anything
 * else (a bare LiveKit room name with no Matrix identity) cannot be membership-
 * verified and is treated as unresolvable (fail-closed at the call site).
 */
async function resolveMatrixRoomId(room: string): Promise<string | null> {
  if (room.startsWith('!')) return room
  if (room.startsWith('#')) {
    try {
      return await getMatrixClient().getRoomIdByAlias(room)
    } catch {
      return null
    }
  }
  return null
}

/**
 * Validates the OpenID token, verifies the caller is a MEMBER of the requested
 * Matrix room (#257-1), then mints a LiveKit JWT for the room. Throws
 * RoomMembershipError when the caller is not a confirmed member so any
 * authenticated Matrix user can no longer obtain a publish token for an
 * arbitrary room they do not belong to.
 */
export async function handleSfuRequest(body: SfuRequest): Promise<SfuResponse> {
  const matrixUserId = await validateOpenIDToken(body.openid_token.access_token)

  // #257-1: gate publish-token minting on confirmed room membership. The room
  // is resolved to its Matrix room id and the validated identity is checked
  // against Synapse's member list (fail-closed: unresolvable room or non-member
  // → reject).
  const matrixRoomId = await resolveMatrixRoomId(body.room)
  if (!matrixRoomId || !(await getSynapseAdmin().isRoomMember(matrixRoomId, matrixUserId))) {
    throw new RoomMembershipError()
  }

  const roomName = livekitRoomName(body.room)

  const jwt = await mintToken({
    roomName,
    identity: matrixUserId,
    displayName: matrixUserId.split(':')[0].replace('@', ''),
    canPublish: true,
  })

  return { url: livekitServerUrl(), jwt }
}

export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}
