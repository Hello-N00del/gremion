// Short per-user cache for the shell's unread badge.
//
// The root layout load re-runs on every client navigation and used to await a full Matrix
// /sync for the badge each time. With many people clicking at once on one homeserver those
// calls queue, and every page waits for the 4 s cap. The count is now cached for a short time:
// a page that was just rendered does not ask the homeserver again.
//
// Rules:
//   - keyed by tenant id and the token subject, so one user never gets another's count and the
//     same subject in two tenants stays apart;
//   - 20 s lifetime, at most UNREAD_CACHE_MAX entries (expired ones are swept first, then the
//     oldest goes), so it cannot grow with the number of users;
//   - only a successful read is stored (the caller never stores a failure or a degraded sync),
//     and not one that was overtaken by forgetUnread while it ran;
//   - no key (no tenant scope, token without a subject) means no caching, never a shared key.
import { currentTenantId } from '$lib/server/tenant/context'

export const UNREAD_CACHE_TTL_MS = 20_000
export const UNREAD_CACHE_MAX = 500

interface Entry {
  count: number
  expiresAt: number
}

const cache = new Map<string, Entry>()

// forgetUnread notes, per user, a sequence number; beginUnreadRead hands out the current one.
let forgetSeq = 0
const noteForgotten = new Map<string, { seq: number; expiresAt: number }>()

function subjectOf(jwt: string): string | null {
  try {
    const part = jwt.split('.')[1] ?? ''
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf-8')) as { sub?: unknown }
    return typeof payload.sub === 'string' && payload.sub !== '' ? payload.sub : null
  } catch {
    return null
  }
}

function keyFor(accessToken: string | null): string | null {
  if (!accessToken) return null
  const sub = subjectOf(accessToken)
  if (!sub) return null
  try {
    return `${currentTenantId()}|${sub}`
  } catch {
    return null
  }
}

export function getCachedUnread(accessToken: string | null): number | null {
  const key = keyFor(accessToken)
  if (!key) return null
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() >= hit.expiresAt) {
    cache.delete(key)
    return null
  }
  return hit.count
}

/**
 * Call before the sync starts and pass the result to setCachedUnread. A read that finished after
 * forgetUnread ran for the same user (the user marked a room read while the sync was in flight)
 * was computed from older state and must not be stored.
 */
export function beginUnreadRead(): number {
  return forgetSeq
}

export function setCachedUnread(accessToken: string | null, count: number, began?: number): void {
  const key = keyFor(accessToken)
  if (!key) return
  const now = Date.now()
  if (began !== undefined) {
    const forgotten = noteForgotten.get(key)
    if (forgotten && forgotten.seq > began && now < forgotten.expiresAt) return
  }
  cache.delete(key)
  if (cache.size >= UNREAD_CACHE_MAX) {
    for (const [k, v] of cache) if (now >= v.expiresAt) cache.delete(k)
    // Still full: drop the oldest entries (Map keeps insertion order).
    while (cache.size >= UNREAD_CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }
  cache.set(key, { count, expiresAt: now + UNREAD_CACHE_TTL_MS })
}

/** Drop one user's entry, e.g. after a room was marked read, so the badge refreshes at once. */
export function forgetUnread(accessToken: string | null): void {
  const key = keyFor(accessToken)
  if (!key) return
  cache.delete(key)
  // Remember that this user's state changed, for a sync that is running right now (see
  // beginUnreadRead). The note only matters while such a sync can still finish (the caller caps
  // it at a few seconds), so it lives as long as a cache entry and is bounded like the cache.
  const now = Date.now()
  noteForgotten.delete(key)
  while (noteForgotten.size >= UNREAD_CACHE_MAX) {
    const oldest = noteForgotten.keys().next().value
    if (oldest === undefined) break
    noteForgotten.delete(oldest)
  }
  noteForgotten.set(key, { seq: ++forgetSeq, expiresAt: now + UNREAD_CACHE_TTL_MS })
}

export function clearAllUnreadCache(): void {
  cache.clear()
  noteForgotten.clear()
}

export function unreadCacheSize(): number {
  return cache.size
}
