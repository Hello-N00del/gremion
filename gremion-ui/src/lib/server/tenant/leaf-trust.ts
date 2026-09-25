// src/lib/server/tenant/leaf-trust.ts
// Tenancy D1 (§1.5) — HARDENING-3: a leaf callback selects its tenant by ID.
//
// ── The coupling this file removes ───────────────────────────────────────────
// A leaf service (newsletter / content) identifies tenants by `x-tenant-id` +
// `x-tenant-slug`. It has no hostname of its own and no reason to know one. Yet
// to reach a kernel callback it had to produce a `x-forwarded-host`, because the
// element-0 resolver selects the tenant by looking that header up in
// `tenant_domain`. So the leaf had to obtain — and keep — a fact that lives in
// the kernel's control plane and that only the kernel can change.
//
// Every way of giving it that fact is a replica with the usual replica problems:
//   * synthesising `<slug>.<apex>` (pre-D1) — wrong the moment a tenant brings
//     its own domain, and a CROSS-TENANT selector the moment another tenant
//     registers that exact string;
//   * threading it down as `x-tenant-host` and persisting it in the leaf's
//     `tenant_catalog.primary_host` (D1 stage D) — correct, but it is a cache
//     with no backfill: until a kernel-driven request has taught each leaf each
//     tenant's host, every SCHEDULER-driven callback (which has no inbound
//     request to read a header from) has no host and fails closed. It also goes
//     stale when an operator moves a host, which needed a whole second
//     mechanism (the leaf-callback 409 cross-check) to stay merely loud.
//
// The host was never the thing being communicated — the TENANT was. The host was
// a lossy, replicated, DNS-shaped encoding of it. So the callback stops carrying
// one: it asserts the tenant id it already holds, and the kernel resolves that id
// directly. No backfill, no staleness, no invalidation, no second mechanism.
//
// ── Why this does not weaken element-0 ───────────────────────────────────────
// `x-tenant-id` is a plain request header, and element-0 is the single most
// security-sensitive function in the app. The id path is therefore gated on ALL
// of the following, and is refused unless every one holds:
//
//   1. the request path is one of a FIXED, exhaustive allowlist of leaf-callback
//      routes (below) — exact match, never a prefix, so no future route under
//      `/api/internal/<leaf>/` inherits the trust by accident;
//   2. `x-internal-auth` constant-time-matches the shared secret THAT ROUTE
//      validates for itself (`INTERNAL_NEWSLETTER_SECRET` /
//      `INTERNAL_CONTENT_SECRET`). Unset secret ⇒ no trust, ever;
//   3. `x-tenant-id` is present and UUID-shaped.
//
// Condition (2) is what makes this safe, and it is worth being precise about
// why: Traefik injects a valid `x-proxy-trust` on EVERY request that matched a
// router (see the SECURITY INVARIANT in resolve.ts), so proxy-trust proves
// "arrived through the edge" and could NEVER gate a header-driven tenant
// selector — an external client would simply send `x-tenant-id: <victim>`. The
// per-leaf internal secret is the opposite: the edge never injects it, no client
// can obtain it, and the kernel already treats presenting it as "you are that
// leaf" on these exact four routes.
//
// Authority check — does the id path let a leaf do anything it could not do
// before? No. A leaf holding `INTERNAL_NEWSLETTER_SECRET` could already invoke
// these routes for ANY tenant by sending that tenant's registered host, and it
// held every tenant's host in its own catalog (that is what stage D put there),
// plus every tenant's newsletter database. The leaf is already trusted for all
// tenants; the id path only stops it needing a DNS fact to say which one. What
// it removes is real: a stale or moved host can no longer aim a callback at the
// wrong tenant, because the host is no longer an input.
//
// Condition (1) is what keeps the blast radius at four routes: the leaf secret
// selects a tenant ONLY on the callbacks it is the secret for. It cannot be used
// to browse that tenant's app, because no other path consults this function.
//
// PURE apart from the two env reads; no I/O, no DB, no network.
import { constantTimeEqual } from '$lib/server/internal-fetch'

/**
 * The exhaustive set of kernel routes a leaf service calls back into, mapped to
 * the env var holding the shared secret THAT ROUTE validates in its own handler.
 *
 * Keep this table and the route handlers in lockstep: an entry here whose secret
 * name differs from the one the handler checks would let element-0 select a
 * tenant for a request the handler then 403s (fail-closed, but confusing), and a
 * callback route MISSING from here simply keeps the host path (fail-closed too —
 * the leaf sends no host, so it 404s).
 *
 * Exact pathnames. There is no prefix matching by design: `/api/internal/push`
 * is deliberately absent (it is an internalFetch/Bearer route, not a leaf
 * callback), and any route added under these prefixes later must be added here
 * DELIBERATELY rather than inheriting leaf trust.
 */
export const LEAF_CALLBACK_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  '/api/internal/newsletter/render': 'INTERNAL_NEWSLETTER_SECRET',
  '/api/internal/newsletter/resolve-group': 'INTERNAL_NEWSLETTER_SECRET',
  '/api/internal/newsletter/send-mail': 'INTERNAL_NEWSLETTER_SECRET',
  '/api/internal/content/portal-publish': 'INTERNAL_CONTENT_SECRET',
})

/** uuid shape — the same format-only regex the callback bodies use for ids. */
const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Read a leaf secret from `process.env` and NOWHERE else.
 *
 * Deliberately NOT the `$env/dynamic/private`-first `readEnv` used elsewhere in
 * this trust family: the four handlers read `process.env.INTERNAL_*_SECRET`
 * directly, and the whole point of condition (2) is that element-0's acceptance
 * is EXACTLY the handler's acceptance. Reading a second source could accept a
 * request the handler then rejects. (Under the Node adapter the two are the same
 * object anyway; this only pins the guarantee.)
 */
function readLeafSecret(envName: string): string | null {
  const value = process.env[envName]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Strip exactly one trailing slash so `/x/` and `/x` are the same route. */
function canonicalPath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

/** What a proven leaf callback asserts: the tenant it is acting for. */
export interface LeafCallbackClaim {
  /** The route that was matched (canonicalised) — for logs, never for auth. */
  readonly route: string
  /** The env var whose secret authenticated this claim — name only, never the value. */
  readonly secretName: string
  /** The tenant id the leaf asserts. Element-0 resolves THIS, no host involved. */
  readonly tenantId: string
}

/**
 * Is this request a proven leaf callback, and which tenant does it claim?
 *
 * Returns `null` — meaning "not a leaf callback, carry on with the host path
 * unchanged" — for every request that is not on an allowlisted route, does not
 * present that route's secret, or does not assert a UUID-shaped tenant id. There
 * is no partial trust and no fallback: a caller that gets this wrong is simply an
 * ordinary request, and an ordinary request with no `x-forwarded-host` 404s.
 *
 * @param pathname `event.url.pathname` (never the raw URL — no query, no origin).
 * @param headers  the inbound request headers.
 */
export function leafCallbackClaim(pathname: string, headers: Headers): LeafCallbackClaim | null {
  const route = canonicalPath(pathname)
  const secretName = LEAF_CALLBACK_ROUTES[route]
  if (secretName === undefined) return null

  // Fail-CLOSED on an unset secret: a kernel with no INTERNAL_<LEAF>_SECRET must
  // never be talked into trusting an unauthenticated x-tenant-id.
  const expected = readLeafSecret(secretName)
  if (!expected) return null

  const supplied = headers.get('x-internal-auth')
  if (!supplied) return null
  if (!constantTimeEqual(supplied, expected)) return null

  const tenantId = headers.get('x-tenant-id')
  if (!tenantId || !TENANT_ID_PATTERN.test(tenantId)) return null

  return { route, secretName, tenantId }
}
