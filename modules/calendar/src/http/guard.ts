// services/calendar/src/http/guard.ts
// Internal-only request guard for the calendar leaf. Every route EXCEPT the
// health probe requires:
//   1. a correct `x-internal-auth` shared secret (constant-time compare via
//      timingSafeEqual — mirrors gremion-ui/src/routes/api/internal/push/+server.ts;
//      env var INTERNAL_CALENDAR_SECRET) → else 403, and
//   2. `x-tenant-id` + a grammar-valid `x-tenant-slug` (slug grammar mirrors
//      gremion-ui/src/lib/server/tenant/slug.ts — this is a SEPARATE process so the
//      rule is duplicated, not imported; keep the two in sync) → else 400.
// Order matters: the secret is checked FIRST so an unauthenticated caller never
// learns anything about the tenant-header validation (no 400-vs-403 oracle).
import { timingSafeEqual } from 'node:crypto'

/** Mirror of SLUG_PATTERN in gremion-ui/src/lib/server/tenant/slug.ts. */
export const SLUG_PATTERN = /^[a-z0-9-]{1,30}$/

export interface TenantHeaders {
  id: string
  slug: string
}

export type GuardResult =
  | { ok: true; tenant: TenantHeaders }
  | { ok: false; status: 400 | 403; message: string }

export interface GuardInput {
  path: string
  headers: Record<string, string | undefined>
  secret: string | undefined
}

/** /healthz and its subpaths are guard-EXEMPT (liveness/readiness probes have no
 *  secret/tenant context). Exact `/healthz` or a `/healthz/<sub>` segment only —
 *  `/healthzzz` is NOT exempt. */
export function isHealthzPath(path: string): boolean {
  return path === '/healthz' || path.startsWith('/healthz/')
}

/** Constant-time secret compare. Returns false on any length/format mismatch
 *  without leaking length via early return (pads to equal length first). */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  const len = Math.max(a.length, b.length)
  const pa = Buffer.alloc(len)
  const pb = Buffer.alloc(len)
  a.copy(pa)
  b.copy(pb)
  return timingSafeEqual(pa, pb) && a.length === b.length
}

export function checkGuard(input: GuardInput): GuardResult {
  const { headers, secret } = input

  // 1. Shared secret (fail-closed if the server has none configured).
  const provided = headers['x-internal-auth']
  if (!secret || !provided || !secretMatches(provided, secret)) {
    return { ok: false, status: 403, message: 'forbidden' }
  }

  // 2. Tenant identity headers.
  const id = headers['x-tenant-id']
  if (!id) return { ok: false, status: 400, message: 'missing x-tenant-id header' }
  const slug = headers['x-tenant-slug']
  if (!slug) return { ok: false, status: 400, message: 'missing x-tenant-slug header' }
  if (!SLUG_PATTERN.test(slug)) {
    return { ok: false, status: 400, message: 'x-tenant-slug must match ^[a-z0-9-]{1,30}$' }
  }

  return { ok: true, tenant: { id, slug } }
}
