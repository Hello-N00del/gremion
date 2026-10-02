// services/messages/src/livekit/livekit-client.ts
// Leaf-side LiveKit token minter + room-name helpers. Standalone (node:crypto only
// — no livekit-server-sdk dep, keeping the leaf dependency-free per its Dockerfile
// contract). The leaf holds the LiveKit API key/secret (its own env) and signs a
// room-pinned HS256 access token server-side. This is the forwarding building
// block the MESSAGES_BACKEND=service cutover wires into the video.token op.
//
// Mirrors the kernel gremion-ui/src/lib/server/messages/livekit-client.ts grant
// shape + tenant room-namespace, with the per-request tenant slug passed in
// (rather than resolved from an AsyncLocalStorage context).

import { createHmac, createHash } from 'node:crypto'

/**
 * `t.<slug>.` for every tenant. TASK-042 (PRD-PLAT-012): there is no default
 * tenant, so no slug earns the old un-prefixed namespace.
 */
export function livekitRoomNamespace(tenantSlug: string): string {
  return `t.${tenantSlug}.`
}

/** Stable LiveKit room name from a Matrix room id (tenant-namespaced). */
export function roomNameFromMatrixId(tenantSlug: string, matrixRoomId: string): string {
  const localpart = matrixRoomId.replace(/^!/, '').split(':')[0]
  return `${livekitRoomNamespace(tenantSlug)}stura-room-${localpart}`
}

/** Stable, order-independent LiveKit room name for a 1:1 DM (tenant-namespaced). */
export function dmRoomName(tenantSlug: string, userIdA: string, userIdB: string): string {
  const sorted = [userIdA, userIdB].sort().join(':')
  const hash = createHash('sha256').update(sorted).digest('hex').slice(0, 16)
  return `${livekitRoomNamespace(tenantSlug)}stura-dm-${hash}`
}

export interface LivekitConfig {
  apiKey: string
  apiSecret: string
}

export interface MintOptions {
  identity: string
  displayName: string
  canPublish: boolean
  /** Token TTL in seconds (default 3600 = 1h, matching the kernel mintToken). */
  ttlSeconds?: number
}

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url')
}

/**
 * Mint a LiveKit-compatible HS256 access token with a ROOM-PINNED video grant.
 * Byte-compatible with a LiveKit JWT (iss=apiKey, video grant, HS256 over the
 * apiSecret) — the same structure the kernel's livekit-server-sdk AccessToken
 * emits, produced here without the SDK to keep the leaf dependency-free.
 */
export function mintLivekitToken(cfg: LivekitConfig, roomName: string, opts: MintOptions): string {
  const now = Math.floor(Date.now() / 1000)
  const ttl = opts.ttlSeconds ?? 3600
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = {
    iss: cfg.apiKey,
    sub: opts.identity,
    name: opts.displayName,
    nbf: now,
    iat: now,
    exp: now + ttl,
    video: {
      room: roomName,
      roomJoin: true,
      canPublish: opts.canPublish,
      canSubscribe: true,
      canPublishData: opts.canPublish,
    },
  }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const sig = createHmac('sha256', cfg.apiSecret).update(signingInput).digest('base64url')
  return `${signingInput}.${sig}`
}
