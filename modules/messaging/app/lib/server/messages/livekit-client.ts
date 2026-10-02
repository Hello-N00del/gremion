import { AccessToken } from 'livekit-server-sdk'
import { createHash } from 'node:crypto'
import { serviceEnv } from '$lib/server/env/service-env'
import { getTenant, type TenantContext } from '$lib/server/tenant/context'
import { resolveSecret } from '$lib/server/tenant/secrets'

// ── P2.1b T7 (D-LIVEKIT): per-tenant url/key/secret resolution ──────────────
// TASK-042 (PRD-PLAT-012): there is no default tenant, so every tenant resolves its registry services refs
// lazily (falling back to the deployment-wide service env) and the result is cached per canonical tenant id
// (a `file:` secret ref would otherwise re-read the file on every mint). evictLivekitSettings() drops a
// tenant's cached resolution (T8 evictTenantRuntime).

interface LkResolved {
  url?: string
  apiKey?: string
  apiSecret?: string
}

const _lkByTenant = new Map<string, LkResolved>()

function lkEntry(ctx: TenantContext): LkResolved {
  let e = _lkByTenant.get(ctx.id)
  if (!e) {
    e = {}
    _lkByTenant.set(ctx.id, e)
  }
  return e
}

/** The LiveKit signalling URL for the CURRENT tenant. */
export function livekitServerUrl(): string {
  const ctx = getTenant()
  const e = lkEntry(ctx)
  if (e.url === undefined) e.url = ctx.services?.livekitUrl ?? serviceEnv('LIVEKIT_URL') ?? 'ws://livekit:7880'
  return e.url
}

function apiKey(): string {
  const ctx = getTenant()
  const e = lkEntry(ctx)
  if (e.apiKey === undefined) {
    e.apiKey = ctx.services?.livekitApiKeyRef
      ? resolveSecret(ctx.services.livekitApiKeyRef)
      : (serviceEnv('LIVEKIT_API_KEY') ?? '')
  }
  if (e.apiKey) return e.apiKey
  throw new Error('LIVEKIT_API_KEY not configured')
}

function apiSecret(): string {
  const ctx = getTenant()
  const e = lkEntry(ctx)
  if (e.apiSecret === undefined) {
    e.apiSecret = ctx.services?.livekitApiSecretRef
      ? resolveSecret(ctx.services.livekitApiSecretRef)
      : (serviceEnv('LIVEKIT_API_SECRET') ?? '')
  }
  if (e.apiSecret) return e.apiSecret
  throw new Error('LIVEKIT_API_SECRET not configured')
}

/** Drop a tenant's cached url/key/secret resolution (T8 evictTenantRuntime). */
export function evictLivekitSettings(tenantId: string): void {
  _lkByTenant.delete(tenantId)
}

/** Test-only: clear the per-tenant settings cache. */
export function __resetLivekitForTests(): void {
  _lkByTenant.clear()
}

// ── P2.1b T7 (D-LIVEKIT): tenant-slug room namespace ────────────────────────
// Room names of EVERY tenant carry a `t.<slug>.` prefix (TASK-042: no tenant keeps the old un-prefixed
// namespace; the leaf's livekitRoomNamespace says the same). `.` cannot appear in a slug
// (^[a-z0-9-]{1,30}$, slug.ts), so the namespace parses unambiguously — no slug can be a prefix of another
// slug's namespace (the reason `--` was NOT chosen: slugs may contain `-`/`--`).

/** `t.<slug>.` for every tenant. */
export function livekitRoomNamespace(): string {
  return `t.${getTenant().slug}.`
}

/**
 * D-LIVEKIT: refuse to mint a grant for a room outside the CURRENT tenant's
 * namespace. A tenant may only mint rooms under its own `t.<slug>.`. Combined with the room-pinned grant
 * below this retires R12 (cross-tenant video access): a user cannot mint a token into another tenant's room
 * even by passing that room name verbatim.
 */
export function assertRoomInTenantNamespace(roomName: string): void {
  const ctx = getTenant()
  if (!roomName.startsWith(`t.${ctx.slug}.`)) {
    throw new Error(
      `cross-tenant room rejected: "${roomName}" is outside tenant "${ctx.slug}"'s namespace`,
    )
  }
}

/**
 * Derives a stable Livekit room name from a Matrix room ID.
 * Input:  !abc123:matrix.example.com
 * Output: t.<slug>.stura-room-abc123
 */
export function roomNameFromMatrixId(matrixRoomId: string): string {
  const localpart = matrixRoomId.replace(/^!/, '').split(':')[0]
  return `${livekitRoomNamespace()}stura-room-${localpart}`
}

/**
 * Derives a stable, order-independent Livekit room name for a 1:1 DM.
 * Uses SHA-256 of sorted Matrix user IDs (first 16 hex chars).
 */
export function dmRoomName(userIdA: string, userIdB: string): string {
  const sorted = [userIdA, userIdB].sort().join(':')
  const hash = createHash('sha256').update(sorted).digest('hex').slice(0, 16)
  return `${livekitRoomNamespace()}stura-dm-${hash}`
}

export interface MintTokenOptions {
  roomName: string
  identity: string
  displayName: string
  canPublish: boolean
}

/**
 * Mints a Livekit JWT (60 min TTL) with a ROOM-PINNED grant after asserting
 * the room belongs to the current tenant's namespace (D-LIVEKIT).
 * canPublish=false produces a subscribe-only token (for Guests joining room calls).
 */
export async function mintToken(opts: MintTokenOptions): Promise<string> {
  assertRoomInTenantNamespace(opts.roomName)
  const token = new AccessToken(apiKey(), apiSecret(), {
    identity: opts.identity,
    name: opts.displayName,
    ttl: '1h',
  })
  token.addGrant({
    roomJoin: true,
    room: opts.roomName,
    canPublish: opts.canPublish,
    canSubscribe: true,
    canPublishData: opts.canPublish,
  })
  return token.toJwt()
}
