// Display names for the senders of Matrix messages.
//
// The Matrix client returns a sender as a Matrix id, and the messages page used to show it as it
// was. Synapse takes the localpart of that id from the Keycloak username, so the member is found
// in the tenant's own identity data by that username: one exact lookup per sender, cached, and
// never one Matrix call per message. Only the first and last name are used, never the address.
//
// Everything here degrades to a readable name derived from the id itself (sender-label.ts) and
// NEVER throws: a failed lookup must not take the message list or the live sync down. A failure
// is still logged (tenant id and error kind only, never the member), because the fallback reads
// like a real name and would otherwise hide a broken identity lookup.

import { currentTenantId } from '$lib/server/tenant/context'
import { getKeycloakAdminClientForCurrentTenant } from '$lib/server/keycloak-admin'
import { fallbackSenderName, isShowableName, localpartOf } from '$lib/components/messaging/sender-label'

/** The identity data this resolver needs from a member: nothing but the name parts. */
export interface NameParts {
  readonly firstName?: string | null
  readonly lastName?: string | null
}

/** Look a member up by Keycloak username. `null` = no such member. May reject. */
export type UsernameLookup = (username: string) => Promise<NameParts | null>

export interface SenderNameResolver {
  /** sender id -> label. Every requested id is present in the map; a miss maps to the fallback. */
  resolveMany(senders: readonly string[]): Promise<Map<string, string>>
  /** Test/maintenance hook: forget every cached name. */
  clear(): void
}

const TTL_MS = 5 * 60_000 // names change rarely; keeps the identity service load tiny
const NEGATIVE_TTL_MS = 30_000 // an unknown member or a failed lookup is retried sooner
const CONCURRENCY = 5 // a room with many distinct senders must not fire them all at once
const BUDGET_MS = 2_000 // a slow identity service must not hold a message snapshot back for long

interface Entry {
  /** The member's name, or null when there is no usable one (fallback applies). */
  name: string | null
  expiresAt: number
}

function nameOf(parts: NameParts | null): string | null {
  if (!parts) return null
  const full = [parts.firstName, parts.lastName].filter((p) => p && p.trim()).join(' ').trim()
  return isShowableName(full) ? full : null
}

export function createSenderNameResolver(
  lookup: UsernameLookup,
  opts: {
    ttlMs?: number
    negativeTtlMs?: number
    budgetMs?: number
    now?: () => number
    /** Called once per failed lookup (a failure is cached for the negative TTL, so this is rate-limited). */
    onError?: (error: unknown) => void
  } = {},
): SenderNameResolver {
  const ttl = opts.ttlMs ?? TTL_MS
  const negTtl = opts.negativeTtlMs ?? NEGATIVE_TTL_MS
  const budget = opts.budgetMs ?? BUDGET_MS
  const now = opts.now ?? (() => Date.now())
  const cache = new Map<string, Entry>()
  const inflight = new Map<string, Promise<string | null>>()

  function fetchName(username: string): Promise<string | null> {
    const hit = cache.get(username)
    if (hit && now() < hit.expiresAt) return Promise.resolve(hit.name)
    const pending = inflight.get(username)
    if (pending) return pending
    const p = (async () => {
      try {
        const name = nameOf(await lookup(username))
        cache.set(username, { name, expiresAt: now() + (name ? ttl : negTtl) })
        return name
      } catch (e) {
        cache.set(username, { name: null, expiresAt: now() + negTtl })
        try {
          opts.onError?.(e)
        } catch {
          // a logging problem must not turn into a lookup failure
        }
        return null
      } finally {
        inflight.delete(username)
      }
    })()
    inflight.set(username, p)
    return p
  }

  return {
    async resolveMany(senders) {
      const unique = [...new Set(senders)]
      const resolved = new Map<string, string>()
      const work = (async () => {
        for (let i = 0; i < unique.length; i += CONCURRENCY) {
          const chunk = unique.slice(i, i + CONCURRENCY)
          const names = await Promise.all(chunk.map((id) => fetchName(localpartOf(id))))
          chunk.forEach((id, j) => {
            if (names[j] != null) resolved.set(id, names[j]!)
          })
        }
      })()
      // Past the budget the caller gets the fallback for whatever is still open; the lookups keep
      // running and fill the cache for the next call.
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<void>((res) => {
        timer = setTimeout(res, budget)
      })
      try {
        await Promise.race([work, timeout])
      } finally {
        clearTimeout(timer)
      }
      work.catch(() => {})
      const out = new Map<string, string>()
      for (const id of unique) out.set(id, resolved.get(id) ?? fallbackSenderName(id))
      return out
    },
    clear: () => {
      cache.clear()
      inflight.clear()
    },
  }
}

// One resolver per tenant, so a name cached for one tenant can never be served to another. A small
// bounded registry (oldest dropped first); the TTL bounds how long a dropped tenant's names live.
const REGISTRY_MAX = 32
const registry = new Map<string, SenderNameResolver>()

function errorKind(e: unknown): string {
  const name = e instanceof Error ? e.name : typeof e
  const status = (e as { status?: unknown } | null)?.status
  return typeof status === 'number' ? `${name} (HTTP ${status})` : name
}

function warnLookupFailed(tenantId: string, e: unknown): void {
  console.warn('[messages] sender name lookup failed; showing names derived from the ids', {
    tenant: tenantId,
    error: errorKind(e),
  })
}

/** Drop a tenant's resolver (and its cached names, and the admin client it holds). Tenant evict seam. */
export function evictSenderNameResolver(tenantId: string): void {
  registry.get(tenantId)?.clear()
  registry.delete(tenantId)
}

/** The calling tenant's resolver. Reads the tenant from the request context and THROWS without one. */
export function getSenderNameResolver(): SenderNameResolver {
  const tenantId = currentTenantId()
  let resolver = registry.get(tenantId)
  if (!resolver) {
    const admin = getKeycloakAdminClientForCurrentTenant()
    resolver = createSenderNameResolver(
      async (username) => {
        const [user] = await admin.listUsers({ username, exact: true, max: 1 })
        return user ?? null
      },
      { onError: (e) => warnLookupFailed(tenantId, e) },
    )
    if (registry.size >= REGISTRY_MAX) {
      const oldest = registry.keys().next().value
      if (oldest !== undefined) {
        registry.get(oldest)?.clear()
        registry.delete(oldest)
      }
    }
    registry.set(tenantId, resolver)
  }
  return resolver
}

/** The resolver, or null when there is no tenant context (callers then use the id-derived fallback). */
export function tryGetSenderNameResolver(): SenderNameResolver | null {
  let tenantId: string
  try {
    tenantId = currentTenantId()
  } catch {
    return null // no tenant context: nothing to look up, and nothing worth logging
  }
  try {
    return getSenderNameResolver()
  } catch (e) {
    // The tenant exists but its identity client cannot be built (missing or unreadable secret, ...).
    warnLookupFailed(tenantId, e)
    return null
  }
}

/** Test-only: drop every tenant's resolver. */
export function __resetSenderNamesForTests(): void {
  for (const r of registry.values()) r.clear()
  registry.clear()
}

function senderOf(message: object): string | null {
  const s = (message as { sender?: unknown }).sender
  return typeof s === 'string' && s !== '' ? s : null
}

/** Set `senderDisplayName` on every message that has a sender. Never throws. */
export async function withSenderNames<T extends object>(
  messages: readonly T[],
  resolver: SenderNameResolver | null = tryGetSenderNameResolver(),
): Promise<T[]> {
  const senders = messages.map(senderOf).filter((s): s is string => s !== null)
  let names = new Map<string, string>()
  if (resolver && senders.length > 0) {
    try {
      names = await resolver.resolveMany(senders)
    } catch (e) {
      console.warn('[messages] sender name resolution failed; showing names derived from the ids', {
        error: errorKind(e),
      })
      names = new Map()
    }
  }
  return messages.map((m) => {
    const sender = senderOf(m)
    if (sender === null) return m
    return { ...m, senderDisplayName: names.get(sender) ?? fallbackSenderName(sender) }
  })
}

interface HasEvents {
  rooms: Array<{ events: Array<object> }>
}

/** Name the events of every room of one sync response with a single resolution pass. */
export async function nameSyncResponse<R extends HasEvents>(
  resp: R,
  resolver: SenderNameResolver | null = tryGetSenderNameResolver(),
): Promise<R> {
  const flat = resp.rooms.flatMap((r) => r.events)
  const named = await withSenderNames(flat, resolver)
  let i = 0
  return {
    ...resp,
    rooms: resp.rooms.map((r) => ({ ...r, events: r.events.map(() => named[i++]!) })),
  } as R
}
