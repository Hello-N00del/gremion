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

export const BOOT_AND_RESOLVE_EXEMPT_PATHS: readonly string[] = Object.freeze(['/healthz', '/api/internal/'])

/** True iff `path` (a URL pathname) is on the closed boot-and-resolve exemption list. */
export function isBootAndResolveExempt(path: string): boolean {
  return BOOT_AND_RESOLVE_EXEMPT_PATHS.some((entry) =>
    entry.endsWith('/') ? path.startsWith(entry) : path === entry,
  )
}
