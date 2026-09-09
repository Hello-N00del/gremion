// Cached Keycloak UUID → display-name resolver (WI-4 Phase A).
//
// Read surfaces store the real Keycloak UUID for `created_by` / signer
// `user_id` / assignee, but members must never see a raw UUID. This server
// util turns a UUID into a friendly display name ("Vorname Nachname"), backed
// by a small TTL cache so a page that resolves the same signer repeatedly hits
// Keycloak at most once per TTL window.
//
// Design notes:
//  - The user lookup is injected (`UserLookup`) so the resolver is unit-testable
//    without stubbing the global fetch; the default singleton wires the existing
//    KeycloakAdminClient.
//  - It NEVER throws. A lookup failure (user deleted, Keycloak down) degrades to
//    the raw id — the same value the UI showed before this resolver existed — and
//    is cached briefly so a dead id doesn't hammer Keycloak on every render.

import { getKeycloakAdminClient, type KcUser } from '$lib/server/keycloak-admin'
import { LRUCache } from 'lru-cache'
import { currentTenantId, getTenant } from '$lib/server/tenant/context'

/** Minimal lookup surface the resolver needs — satisfied by KeycloakAdminClient. */
export interface UserLookup {
  getUser(id: string): Promise<Pick<KcUser, 'id' | 'username' | 'firstName' | 'lastName'>>
}

interface CacheEntry {
  name: string
  expiresAt: number
}

/** Build a display name from a Keycloak user, with sensible fallbacks. */
export function displayNameOf(
  u: Pick<KcUser, 'username' | 'firstName' | 'lastName'>,
): string {
  const full = [u.firstName, u.lastName].filter((p) => p && p.trim()).join(' ').trim()
  if (full) return full
  if (u.username && u.username.trim()) return u.username.trim()
  return ''
}

export interface DisplayNameResolver {
  /** Resolve a single id → display name. Falls back to the raw id on miss. */
  resolve(id: string): Promise<string>
  /** Resolve many ids in one go → Map<id, displayName>. Misses map to the raw id. */
  resolveMany(ids: readonly string[]): Promise<Map<string, string>>
  /** Test/maintenance hook: clear the cache. */
  clear(): void
}

const TTL_MS = 5 * 60_000 // 5 min — names change rarely; keep Keycloak load tiny.
const NEGATIVE_TTL_MS = 30_000 // failed lookups: retry sooner than a hit.

export function createDisplayNameResolver(
  lookup: UserLookup,
  opts: { ttlMs?: number; negativeTtlMs?: number; now?: () => number } = {},
): DisplayNameResolver {
  const ttl = opts.ttlMs ?? TTL_MS
  const negTtl = opts.negativeTtlMs ?? NEGATIVE_TTL_MS
  const now = opts.now ?? (() => Date.now())
  const cache = new Map<string, CacheEntry>()

  async function fetchOne(id: string): Promise<string> {
    const hit = cache.get(id)
    if (hit && now() < hit.expiresAt) return hit.name
    try {
      const u = await lookup.getUser(id)
      const name = displayNameOf(u) || id
      // If we got a real name, cache for the full TTL; if Keycloak returned a
      // user with no usable name, treat as a soft miss (short TTL).
      const usable = name !== id
      cache.set(id, { name, expiresAt: now() + (usable ? ttl : negTtl) })
      return name
    } catch {
      cache.set(id, { name: id, expiresAt: now() + negTtl })
      return id
    }
  }

  return {
    resolve: (id) => fetchOne(id),
    async resolveMany(ids) {
      const unique = [...new Set(ids)]
      const entries = await Promise.all(
        unique.map(async (id) => [id, await fetchOne(id)] as const),
      )
      return new Map(entries)
    },
    clear: () => cache.clear(),
  }
}

/** Lookup factory: given a canonical tenant id, return that tenant's lookup.
 *  The `tenantId` arg exists so TESTS can branch per tenant; the production
 *  default ignores it and reads the full TenantContext from ALS (see below). */
export type LookupFactory = (tenantId: string) => UserLookup

/**
 * Default lookup factory: adapt the per-realm Keycloak admin client (Task 25)
 * to the UserLookup surface. `KeycloakAdminClient.getUser(id)` already returns a
 * superset of `Pick<KcUser,'id'|'username'|'firstName'|'lastName'>`, so the
 * client structurally satisfies UserLookup — wrap it explicitly for clarity and
 * to pin the surface. Reads getTenant() from ALS (fail-closed) rather than the
 * `tenantId` arg, so it matches Task 25's `getKeycloakAdminClient(tenant)` shape.
 */
function defaultLookupFactory(): UserLookup {
  const admin = getKeycloakAdminClient(getTenant())
  return { getUser: (id: string) => admin.getUser(id) }
}

// Per-tenant resolver registry. Draining LRU: evicting a tenant drops its
// internal Map<userId,name> so a churned tenant's names cannot resurface.
const REGISTRY_MAX = 32
const _registry = new LRUCache<string, DisplayNameResolver>({
  max: REGISTRY_MAX,
  dispose: (resolver) => resolver.clear(),
})

/**
 * Tenant-scoped resolver. Reads the canonical tenant id from ALS (fail-closed:
 * THROWS if none — never serves tenant #1). The default factory wires each
 * tenant's KC admin client; tests inject their own.
 */
export function getDisplayNameResolver(
  lookupFactory: LookupFactory = () => defaultLookupFactory(),
): DisplayNameResolver {
  const tenantId = currentTenantId()
  let resolver = _registry.get(tenantId)
  if (!resolver) {
    resolver = createDisplayNameResolver(lookupFactory(tenantId))
    _registry.set(tenantId, resolver)
  }
  return resolver
}

/** Drop ONE tenant's resolver (P2.1b T8 — wired by evictTenantRuntime on
 *  tenant suspend/delete). The LRU dispose drains its internal name cache, so
 *  a re-added tenant starts cold — no stale names can resurface. */
export function evictDisplayNameResolver(tenantId: string): void {
  _registry.delete(tenantId)
}

/** Test-only: clear the per-tenant resolver registry (drains every resolver). */
export function __resetDisplayNameRegistryForTests(): void {
  _registry.clear()
}
