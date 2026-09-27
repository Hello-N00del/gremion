// src/lib/server/tenant/resolve.ts
import type { Handle, HandleFetch } from '@sveltejs/kit'
import {
  resolveTenantByHost,
  getTenantStatusByHost,
  resolveTenantById,
  type TenantStatus,
} from '$lib/server/tenant/registry'
import { normaliseHost } from '$lib/server/tenant/host'
import { logHostRejection, type HostRejectReason } from '$lib/server/tenant/host-mismatch-log'
import { leafCallbackClaim } from '$lib/server/tenant/leaf-trust'
import { runWithTenant } from '$lib/server/tenant/context'
import type { TenantContext } from '$lib/server/tenant/context'
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
import { isResolveExemptRequest } from '$lib/server/boot-exempt'

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
 * tenant from the WHOLE trusted edge-forwarded host (x-forwarded-host, injected
 * by Traefik; Tenancy D1 §1.3, TASK-041), sets event.locals.tenant, and runs the
 * downstream chain inside runWithTenant(...) so every tenant-keyed accessor
 * resolves the SAME canonical id (spec §7.1).
 *
 * Security (spec §3.2/§1.6/§7-D7): the raw Host header is attacker-controllable
 * and is NEVER a selector — tenant selection is authoritative ONLY from the
 * edge-injected x-forwarded-host, looked up whole in `tenant_domain` (host is
 * its PRIMARY KEY). Unparseable, unbound or non-active host -> 404 (fail closed,
 * spec §1.7; no default tenant, TRD-075), each emitting one
 * `tenant.host.rejected` event (TRD-076). The Host header is read for ONE thing
 * only: the Q2 cross-check, which can REJECT an edge request whose Host and
 * X-Forwarded-Host disagree and can never select. Control-DB unreachable -> 503.
 * The reroute hook is deliberately NOT used (spec §3.2) — tenant is a data-plane
 * selector in locals, not a route rewrite.
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
// never a selector (TASK-041 Q2 reads it only to REJECT a mismatch).
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
  // TASK-023 (B-05): the closed BOOT_AND_RESOLVE_EXEMPT_PATHS list skips
  // resolution -- no proxy-trust gate, no lookup, no tenant context: /healthz
  // always, an /api/internal/ request only when it names no tenant (see
  // boot-exempt.ts). This must stay the first statement.
  if (isResolveExemptRequest(event.url.pathname, event.request.headers)) return resolve(event)

  // P2.1c (T5): executable proxy-trust. When TENANT_PROXY_SHARED_SECRET is set,
  // an edge request that does not prove proxy-trust (the Traefik-injected
  // x-proxy-trust header, OR a valid T4 internal-fetch hop) is rejected with
  // 403 BEFORE any registry lookup — x-forwarded-host trust no longer rests on
  // topology alone. Computed once and reused for tenantSelectionTrusted below.
  const internalTrusted = isInternalTrustRequest(event.request)

  // Spec B §T.1 HARDENING-3: is this one of the four kernel routes a LEAF
  // service calls back into, presenting THAT route's own shared secret? If so
  // the leaf asserts its tenant by ID and no host is involved at all — see
  // leaf-trust.ts for why the host was the wrong thing to communicate, and why
  // the per-leaf secret (unlike proxy-trust, which Traefik stamps on every edge
  // request) is the only thing that could gate a header-driven selector.
  // `null` for every other request, which therefore takes the whole-host path
  // below (TASK-041).
  const leafClaim = leafCallbackClaim(event.url.pathname, event.request.headers)

  if (!isProxyTrusted(event.request, internalTrusted || leafClaim !== null)) {
    return new Response('Forbidden', { status: 403 })
  }

  let ctx: TenantContext | null
  if (leafClaim) {
    // The ID path. Same registry hydration, same active-only filter and same
    // resolution cache as the host path (resolveTenantById funnels through
    // buildAndCacheTenantContext), so the context a callback runs in is
    // byte-identical to the one a browser request would get.
    try {
      ctx = await resolveTenantById(leafClaim.tenantId)
    } catch (err) {
      tlog('error', '[tenant-resolve] registry lookup failed', {
        route: leafClaim.route,
        err: err instanceof Error ? err.message : String(err),
      })
      return new Response('Service Unavailable: tenant registry', {
        status: 503,
        headers: { 'Retry-After': '5' },
      })
    }
    if (!ctx) {
      // Unknown / suspended / deleting / deleted all collapse to 404 here, on
      // purpose. The host path's branded 503 exists for a BROWSER on a
      // suspended tenant's domain; a leaf is a machine caller with no page to
      // render, and its client treats any non-2xx as a retryable failure that
      // leaves the work claimed. There is no fallback tenant, exactly as on the
      // host path.
      tlog('warn', '[tenant-resolve] leaf callback names no active tenant', {
        route: leafClaim.route,
        claimedTenantId: leafClaim.tenantId,
      })
      return new Response('Not Found', { status: 404 })
    }
  } else {
    const selected = await resolveByForwardedHost(event.request, !internalTrusted)
    if (selected instanceof Response) return selected
    ctx = selected
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

/**
 * TASK-041 (L3-08; B10-resolver-fullhost Task 1, ported from the extraction source's
 * resolve.ts `resolveByForwardedHost`): the host path. Returns the resolved
 * ACTIVE context, or the Response the resolver must return.
 *
 * Outcomes (each 404 emits ONE `tenant.host.rejected` event after the decision
 * and before the return; neither 503 emits):
 *   unparseable / absent x-forwarded-host   -> 404 `unparseable`, NO registry read
 *   edge Host != x-forwarded-host (Q2)      -> 404 `forged`, NO registry read
 *   no tenant_domain row                    -> 404 `unbound`
 *   deleting / deleted tenant               -> 404 `inactive`
 *   suspended tenant                        -> branded 503 (no data plane touched)
 *   control DB unreachable                  -> 503 Retry-After 5
 * There is NO fallback, NO leftmost-label path and NO apex special case.
 *
 * `edge` is true for a request that did not prove internal trust; the caller
 * only reaches here for a request that is not a leaf claim.
 */
async function resolveByForwardedHost(
  request: Request,
  edge: boolean,
): Promise<TenantContext | Response> {
  // Tenancy D1 (§1.3): the WHOLE edge-forwarded host is the tenant selector.
  // `normaliseHost` runs here — before any registry work — so a malformed /
  // ambiguous / absent header 404s without a single control-DB read. The
  // accessors call it again internally (the guard lives in THEM, as
  // resolveTenantBySlug owned validateSlug); normaliseHost is idempotent.
  const rawForwarded = request.headers.get('x-forwarded-host')
  const host = normaliseHost(rawForwarded)
  if (!host) return rejectHost('unparseable', rawForwarded)

  // Q2 (RFC 7239 §8.1; RFC 9110 §7.2): a forwarded header is only as
  // trustworthy as every hop that could set it, and traefik.yml trusts the
  // edge subnets once they are attached — so the edge's per-host pin must not
  // be the only layer. On an EDGE request with the proxy-trust contract in
  // force, the Host the router matched must name the same host the forwarded
  // header does. Reject-only: a match changes nothing, a mismatch is a 404.
  // Internal hops (internalFetch / handleFetch) legitimately carry the
  // container's own Host and are proven by their secret instead.
  if (edge && readProxyTrustSecret() && normaliseHost(request.headers.get('host')) !== host) {
    return rejectHost('forged', host)
  }

  let ctx: TenantContext | null
  let status: TenantStatus | null = null
  try {
    // `host` is tenant_domain's PRIMARY KEY, so the lookup can never be
    // ambiguous; a host that is not a row resolves to NOTHING.
    ctx = await resolveTenantByHost(host)
    // P2.1c (T6): resolveTenantByHost returns null for unknown AND non-active
    // rows alike. The status-only control-DB read (no data plane) separates a
    // SUSPENDED tenant — branded 503 page — from an unregistered host or a
    // provisioning/deleting/deleted row (all 404; §7.8 identifier-reuse
    // defence keeps a tombstoned tenant's hosts unservable).
    if (!ctx) status = await getTenantStatusByHost(host)
  } catch (err) {
    // `host` passed normaliseHost (ASCII LDH, no separators) and tlog emits
    // one-line JSON, so it stays a single structured field.
    tlog('error', '[tenant-resolve] registry lookup failed', {
      host,
      err: err instanceof Error ? err.message : String(err),
    })
    return new Response('Service Unavailable: tenant registry', {
      status: 503,
      headers: { 'Retry-After': '5' },
    })
  }
  if (ctx) return ctx
  if (status === 'suspended') return suspendedTenantResponse()
  return rejectHost(status === null ? 'unbound' : 'inactive', host)
}

/**
 * A host-path 404: decided first, then the TRD-076 event, then the return.
 * The emitter never throws; the try/catch makes that a property of THIS call
 * site too, so no logging failure can turn the 404 into a 500 or a 503.
 */
function rejectHost(reason: HostRejectReason, host: string | null): Response {
  const res = new Response('Not Found', { status: 404 })
  try {
    logHostRejection(reason, host)
  } catch {
    // swallowed: the 404 stands
  }
  return res
}
