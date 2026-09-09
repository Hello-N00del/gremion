// src/lib/server/tenant/resolve.ts
import type { Handle, HandleFetch } from '@sveltejs/kit'
import { resolveTenantBySlug, getTenantStatusBySlug } from '$lib/server/tenant/registry'
import { runWithTenant } from '$lib/server/tenant/context'
import { suspendedTenantResponse } from '$lib/server/tenant/suspended-page'
import {
  getTenantReadiness,
  isFleetPopulated,
  triggerTenantMigrationRetry,
} from '$lib/server/tenant/readiness'
import { checkTenantRateLimit } from '$lib/server/tenant/rate-limit'
import { tlog } from '$lib/server/observability/tenant-log'
import {
  constantTimeEqual,
  readInternalPushSecret,
  readProxyTrustSecret,
} from '$lib/server/internal-fetch'

/**
 * Extract the tenant slug = the leftmost DNS label of the trusted edge-forwarded
 * host. Under the flat single-stem model `tenant.example.org` (spec §3.2 / D3)
 * the tenant lives in the leftmost label. Returns null when there is no tenant
 * subdomain (bare apex, single-label, empty) so the caller can 404 — NEVER a
 * silent default to tenant #1 (spec §1.7 fail-closed RULE).
 *
 * #256-2 hardening (the P2.1c edge makes these header forms reachable):
 *  - comma/whitespace-joined lists (duplicate or chained X-Forwarded-Host
 *    headers join to 'client-value, edge-value') are REJECTED outright —
 *    taking the first (client-most) value would let an attacker-supplied
 *    label win over the trusted hop's appended value; ambiguous = fail closed.
 *  - exactly ONE trailing dot (FQDN root form) is stripped BEFORE splitting,
 *    so 'example.org.' stays the 2-label apex (404) instead of bypassing the
 *    labels.length < 3 rule and resolving the 2LD as a tenant slug.
 *  - EMPTY labels anywhere ('tenant..org', '.t.example.org') are rejected.
 */
export function extractLeftmostLabel(forwardedHost: string | undefined | null): string | null {
  if (!forwardedHost) return null
  const raw = forwardedHost.trim()
  if (!raw) return null
  if (raw.includes(',') || /\s/.test(raw)) return null // multi-value list — fail closed
  let hostNoPort = raw.split(':', 1)[0].toLowerCase()
  if (hostNoPort.endsWith('.')) hostNoPort = hostNoPort.slice(0, -1) // exactly one FQDN root dot
  if (!hostNoPort) return null
  const labels = hostNoPort.split('.')
  if (labels.length < 3) return null // need sub.example.org; fewer = no tenant subdomain
  if (labels.some((l) => l.length === 0)) return null // empty label anywhere — reject
  return labels[0]
}

/**
 * P2.1c (T4): is this request a TRUSTED internal server-to-server caller?
 *
 * `internalFetch` (internal-fetch.ts) re-stamps the current tenant's
 * `x-forwarded-host` on its fresh HTTP hop together with an
 * `x-internal-host-trust` secret. We accept that forwarded host as authoritative
 * — bypassing the (T5) edge proxy-trust requirement — ONLY when the secret
 * constant-time-matches the per-process `INTERNAL_PUSH_SECRET` (the SAME trust
 * domain as the G-075 Bearer: "this process called itself"; no second secret is
 * minted). Comparison is constant-time (`constantTimeEqual`) to defeat timing
 * leaks. Fail-closed: when the secret is unset, this ALWAYS returns false, so a
 * misconfigured deployment cannot be tricked into trusting a forged header.
 *
 * The result is recorded on `event.locals.tenantSelectionTrusted` by the
 * resolver; T5's proxy-trust gate honors it as an OR alongside the edge header.
 */
export function isInternalTrustRequest(request: Request): boolean {
  const expected = readInternalPushSecret()
  if (!expected) return false
  const supplied = request.headers.get('x-internal-host-trust')
  if (!supplied) return false
  return constantTimeEqual(supplied, expected)
}

/**
 * P2.1c (T5): the executable proxy-trust gate makes the SECURITY INVARIANT
 * below enforceable instead of resting on network topology alone. When
 * `TENANT_PROXY_SHARED_SECRET` is set, EVERY edge request must carry a
 * constant-time matching `x-proxy-trust: <secret>` header that Traefik injects
 * on the gremion-ui routers (a value the app is never directly reachable to
 * receive otherwise). An internalFetch hop (`internalTrusted`) never traverses
 * the edge, so it cannot carry the edge header — its constant-time-validated
 * `x-internal-host-trust` (T4) satisfies the gate as an OR.
 *
 * Fail-OPEN by design ONLY when the secret is UNSET: the gate is then a
 * byte-identical no-op so tenant #1's behavior is unchanged until the operator
 * sets the env + the Traefik label together at S4 deploy. Once the secret is
 * set the gate is fail-CLOSED (absent/mismatched header → reject).
 */
export function isProxyTrusted(request: Request, internalTrusted: boolean): boolean {
  const expected = readProxyTrustSecret()
  if (!expected) return true // not configured — no-op (byte-identical default)
  if (internalTrusted) return true // T4 internal-fetch hop — never edge-routed
  const supplied = request.headers.get('x-proxy-trust')
  if (!supplied) return false
  return constantTimeEqual(supplied, expected)
}

/**
 * Element 0 of sequence(...) — runs BEFORE authHandle. Resolves the request's
 * tenant from the TRUSTED edge-forwarded host (x-forwarded-host, injected by
 * Traefik), sets event.locals.tenant, and runs the downstream chain inside
 * runWithTenant(...) so every tenant-keyed accessor resolves the SAME canonical
 * id (spec §7.1).
 *
 * Security (spec §3.2/§1.6/§7-D7): the raw Host header is attacker-controllable
 * and is NEVER read — tenant selection is authoritative ONLY from the
 * edge-injected x-forwarded-host. Unknown/missing subdomain -> 404 (fail closed,
 * spec §1.7). Control-DB unreachable -> 503. The reroute hook is deliberately
 * NOT used (spec §3.2) — tenant is a data-plane selector in locals, not a route
 * rewrite.
 *
 * NOTE on internal callers: internalFetch (internal-fetch.ts) makes a FRESH
 * server-to-server HTTP request WITHOUT an x-forwarded-host, so once this handle
 * is sequence() element 0 those inner calls would 404 (fail-closed). ALS does
 * NOT fix this — AsyncLocalStorage does not cross an HTTP boundary; the new
 * request runs under its own ALS in the receiving handler. This is SOLVED, not
 * outstanding: internalFetch injects a TRUSTED forwarded host for the current
 * tenant, and `isInternalTrustRequest` (T4, above) honors the
 * constant-time-validated `x-internal-host-trust` header as an OR against the
 * (T5) proxy-trust gate. `tenantForwardFetch` (below) is the SvelteKit
 * `handleFetch` half of the same seam, for `event.fetch` callers.
 */
// SECURITY INVARIANT: tenant selection trusts ONLY the edge-injected
// `x-forwarded-host`. This is safe ONLY because Traefik is the sole ingress
// and this app is NEVER directly reachable (enforced by network policy /
// compose+k8s topology). If the app port is ever externally bound, an
// attacker who sets x-forwarded-host selects ANY tenant. Executable
// proxy-trust (a Traefik-injected shared-secret header, constant-time
// compared like internal-fetch.ts G-075) + an "app port not externally
// bound" acceptance check are P2.1c. The in-app backstop is the Task 28
// iss-match assertion (token iss == resolved tenant issuer) before any
// data-plane query. The raw Host header is attacker-controllable and is
// never read.
/**
 * gremion#22 finding 1 (HIGH): P2.1c internalFetch forwarded-host, wired as
 * SvelteKit's `handleFetch`. This is the `event.fetch` half of the seam
 * described in `tenantResolveHandle`'s header above.
 *
 * A `load`/endpoint that calls `event.fetch('/api/...')` makes a fresh
 * server-to-server request (e.g. `members/committees/[id]/protokolle/
 * +page.server.ts` fetching `/api/protocols?committeeId=...`). SvelteKit
 * forwards the caller's cookies for same-origin, but NOT the edge-injected
 * tenant headers — so once `tenantResolveHandle` is sequence element 0 AND
 * `TENANT_PROXY_SHARED_SECRET` is set, that inner request carries neither
 * `x-proxy-trust` (→ 403) nor `x-forwarded-host` (→ 404), silently
 * breaking every such internal `event.fetch` call behind a reverse proxy.
 *
 * We re-stamp the parent request's ALREADY-TRUSTED `x-forwarded-host` plus the
 * constant-time internal-trust secret (`x-internal-host-trust` ==
 * `INTERNAL_PUSH_SECRET`), exactly as `isInternalTrustRequest` expects: that
 * satisfies the (T5) proxy-trust gate as an OR and the resolver reads the
 * injected host — resolving the SAME tenant as the parent, so there is no
 * cross-tenant surface. The host we propagate is the value the resolver already
 * trusted for the parent (never the raw Host); the secret is a per-process
 * server env, never client-reachable.
 *
 * Scope: same-origin only — external fetches (leaf service clients, upstream
 * APIs) have a different origin and MUST NOT receive the internal-trust secret.
 * No-op when the forwarded host or the secret is absent (dev/CI without an
 * edge), so off-staging behaviour is byte-identical.
 */
export const tenantForwardFetch: HandleFetch = async ({ event, request, fetch }) => {
  const url = new URL(request.url)
  const fwdHost = event.request.headers.get('x-forwarded-host')
  const secret = readInternalPushSecret()
  if (fwdHost && secret && url.origin === event.url.origin) {
    const headers = new Headers(request.headers)
    headers.set('x-forwarded-host', fwdHost)
    headers.set('x-internal-host-trust', secret)
    request = new Request(request, { headers })
  }
  return fetch(request)
}

export const tenantResolveHandle: Handle = async ({ event, resolve }) => {
  // P2.1c (T5): executable proxy-trust. When TENANT_PROXY_SHARED_SECRET is set,
  // an edge request that does not prove proxy-trust (the Traefik-injected
  // x-proxy-trust header, OR a valid T4 internal-fetch hop) is rejected with
  // 403 BEFORE any registry lookup — x-forwarded-host trust no longer rests on
  // topology alone. Computed once and reused for tenantSelectionTrusted below.
  const internalTrusted = isInternalTrustRequest(event.request)
  if (!isProxyTrusted(event.request, internalTrusted)) {
    return new Response('Forbidden', { status: 403 })
  }

  const forwardedHost = event.request.headers.get('x-forwarded-host')
  const slug = extractLeftmostLabel(forwardedHost)
  if (!slug) return new Response('Not Found', { status: 404 })

  let ctx
  try {
    // resolveTenantBySlug MUST validate the slug (validateSlug) before any
    // registry/DB use; the guard lives there — do NOT swap it for a raw
    // getTenantBySlug without re-adding validation.
    ctx = await resolveTenantBySlug(slug)
    if (!ctx) {
      // P2.1c (T6): resolveTenantBySlug returns null for unknown / invalid /
      // NON-ACTIVE rows alike. Consult the status-only control-DB read (no
      // data-plane resolution) to distinguish a SUSPENDED tenant — which serves
      // a branded, data-plane-free 503 page instead of the indistinguishable
      // 404 — from a truly unknown slug or a deleting/deleted tombstone (both
      // 404; §7.8 identifier-reuse defence keeps a tombstoned slug unservable).
      // Order: invalid slug → 404; row absent → 404; suspended → 503 page;
      // deleting/deleted → 404. active never reaches here (ctx is non-null).
      const status = await getTenantStatusBySlug(slug)
      if (status === 'suspended') return suspendedTenantResponse()
      return new Response('Not Found', { status: 404 })
    }
  } catch (err) {
    tlog('error', '[tenant-resolve] registry lookup failed', {
      slug,
      err: err instanceof Error ? err.message : String(err),
    })
    return new Response('Service Unavailable: tenant registry', {
      status: 503,
      headers: { 'Retry-After': '5' },
    })
  }

  // P2.1b T3 (D-READY): per-tenant boot readiness gate. A tenant whose
  // data-plane migration failed (or that the boot fleet never saw — `pending`)
  // serves a tenant-scoped 503 and fires ONE single-flighted lazy re-migration;
  // the next resolution re-checks. Other tenants are untouched. The gate stays
  // INERT until the boot fleet populates the map: pre-boot/failed-boot requests
  // fall through to the process-wide boot gate in hooks.server.ts (control-
  // plane failure = process-wide 503), and a request racing the boot fleet can
  // never start a concurrent second migration.
  if (isFleetPopulated() && getTenantReadiness(ctx.id) !== 'ready') {
    void triggerTenantMigrationRetry(ctx)
    return new Response('Service Unavailable: tenant not ready', {
      status: 503,
      headers: { 'Retry-After': '5' },
    })
  }

  // P2.1b T10 (§7.6, D-RATE): per-tenant token bucket — after resolution and
  // the readiness gate (a failing tenant's 503 must not be masked by 429s, and
  // a not-ready tenant spends no tokens), before ANY downstream work. Default
  // OFF (TENANT_RATE_LIMIT_RPS unset ⇒ unconditional pass) so tenant #1 stays
  // byte-identical; when enabled, one tenant's flood 429s ONLY that tenant.
  const rate = checkTenantRateLimit(ctx.id)
  if (!rate.allowed) {
    return new Response('Too Many Requests', {
      status: 429,
      headers: { 'Retry-After': String(rate.retryAfterSec) },
    })
  }

  event.locals.tenant = ctx
  // P2.1c (T4): record whether this request proved internal-trust, so the (T5)
  // proxy-trust gate can honor an internalFetch hop as an OR. A request that
  // never sent (or mis-sent) the secret is NOT trusted (today's behavior).
  // Reuses the value computed for the T5 gate above (single source).
  event.locals.tenantSelectionTrusted = internalTrusted
  return runWithTenant(ctx, () => resolve(event))
}
