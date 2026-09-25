// src/lib/server/boot-exempt.ts
//
// TASK-023 (B-05 option 1): the ONE closed allow-list of request paths that are
// exempt from BOTH the tenant resolver (tenantResolveHandle — no host lookup, no
// proxy-trust gate, no tenant context) AND the process-wide boot 503 in
// hooks.server.ts's authGuard (and from its session guard).
//
//   /healthz        the liveness marker. Always 200, answered during and after
//                   boot, with no host header, no proxy-trust header and zero
//                   tenant rows. It is NOT a readiness probe: a boot-failed or
//                   still-booting process also answers 200 (see
//                   docs/deployment-architecture.md). /api/health stays the boot
//                   probe and is NOT exempt.
//   /api/internal/  server-to-server routes (e.g. the switch's evict fan-out).
//                   They never traverse the edge, so they carry neither a tenant
//                   host nor x-proxy-trust. Every handler under
//                   routes/api/internal/ MUST authenticate itself with
//                   isInternalTrustRequest or constantTimeEqual — a static guard
//                   in boot-exempt.test.ts fails the build otherwise.
//
// Matching: an entry ending in '/' is a prefix; any other entry matches only
// exactly. '/healthzx', '/healthz/' and '/api/internalx' are therefore NOT
// exempt. The list is frozen and pinned by value in boot-exempt.test.ts: a new
// entry is a security decision and must turn that test RED.
//
// What "exempt" means per entry shape (isResolveExemptRequest):
//   * an EXACT entry (/healthz) is one tenant-blind endpoint. It is never
//     resolved, whatever headers it carries: it reads the host itself and must
//     answer 200 for an unknown host too.
//   * a PREFIX entry (/api/internal/) is a route family whose members MAY act
//     for a tenant: the leaf callbacks select theirs by x-tenant-id
//     (leaf-trust.ts) and internalFetch hops by a trusted x-forwarded-host. A
//     request under it that NAMES a tenant is resolved and gated exactly like
//     any other request. Only a request that names none -- e.g. the switch's
//     evict fan-out on the container network -- skips the resolver, and it then
//     has no tenant: getDb() fails closed. The edge always stamps
//     x-forwarded-host, so an edge request never takes the exemption.

export const BOOT_AND_RESOLVE_EXEMPT_PATHS: readonly string[] = Object.freeze(['/healthz', '/api/internal/'])

/** True iff `path` (a URL pathname) is on the closed boot-and-resolve exemption list. */
export function isBootAndResolveExempt(path: string): boolean {
  return BOOT_AND_RESOLVE_EXEMPT_PATHS.some((entry) =>
    entry.endsWith('/') ? path.startsWith(entry) : path === entry,
  )
}

/**
 * Request headers that name a tenant. A request under a PREFIX entry that carries
 * any of them is resolved normally (see the header comment).
 */
const TENANT_SELECTOR_HEADERS: readonly string[] = Object.freeze(['x-forwarded-host', 'x-tenant-id'])

/**
 * Should tenantResolveHandle hand this request on WITHOUT resolving a tenant?
 * True for /healthz always, and for an /api/internal/ request only when it names
 * no tenant. Everything else is resolved (fail-closed, as before).
 */
export function isResolveExemptRequest(path: string, headers: Headers): boolean {
  if (!isBootAndResolveExempt(path)) return false
  const exact = BOOT_AND_RESOLVE_EXEMPT_PATHS.some((entry) => !entry.endsWith('/') && entry === path)
  if (exact) return true
  return !TENANT_SELECTOR_HEADERS.some((h) => headers.has(h))
}
