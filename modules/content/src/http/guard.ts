// services/content/src/http/guard.ts
// Internal-only request guard for the content leaf. Every route EXCEPT the
// health probe requires:
//   1. a correct `x-internal-auth` shared secret (constant-time compare via
//      timingSafeEqual — mirrors gremion-ui/src/routes/api/internal/push/+server.ts;
//      env var INTERNAL_CONTENT_SECRET) → else 403, and
//   2. `x-tenant-id` (a canonical lowercase UUID) + a grammar-valid `x-tenant-slug` (slug grammar mirrors
//      gremion-ui/src/lib/server/tenant/slug.ts — this is a SEPARATE process so the
//      rule is duplicated, not imported; keep the two in sync) → else 400.
// Order matters: the secret is checked FIRST so an unauthenticated caller never
// learns anything about the tenant-header validation (no 400-vs-403 oracle).
import { timingSafeEqual } from 'node:crypto'

/** Mirror of SLUG_PATTERN in gremion-ui/src/lib/server/tenant/slug.ts. */
export const SLUG_PATTERN = /^[a-z0-9-]{1,30}$/

/**
 * A canonical lowercase RFC 9562 uuid (version 1-8, variant 10xx). StuRaOS
 * tenant ids are gen_random_uuid() v4 and the kernel's are v7; Postgres renders a
 * uuid in exactly this form. The id keys the tenant's pool and is bound to the
 * slug by the store's catalog, so anything else is refused here, before any store
 * access (same pattern as the board leaf's guard).
 */
export const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

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

/** True iff the request carries the internal shared secret (fail-closed when the
 *  server has none configured). F1-FIX-07 K5#12/K5#31: /healthz/tenants uses
 *  this (mirrors the finance leaf, F1-FIX-05-K K4#32). */
export function hasInternalSecret(headers: Record<string, string | undefined>, secret: string | undefined): boolean {
  const provided = headers['x-internal-auth']
  return !!secret && !!provided && secretMatches(provided, secret)
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
  if (!TENANT_ID_PATTERN.test(id)) {
    return { ok: false, status: 400, message: 'x-tenant-id must be a canonical lowercase UUID' }
  }
  const slug = headers['x-tenant-slug']
  if (!slug) return { ok: false, status: 400, message: 'missing x-tenant-slug header' }
  if (!SLUG_PATTERN.test(slug)) {
    return { ok: false, status: 400, message: 'x-tenant-slug must match ^[a-z0-9-]{1,30}$' }
  }

  // Tenancy D1 HARDENING-3: there is deliberately no host header to validate
  // here. `x-tenant-host` was the kernel telling this leaf a tenant's registered
  // hostname so its own callbacks could carry one back; the kernel now selects a
  // callback's tenant from `x-tenant-id` under the same shared secret checked
  // above, so the leaf holds no hostname and reads none. The two identity
  // headers are the whole tenant contract.
  return { ok: true, tenant: { id, slug } }
}
