// G-075 — server-only internal-call helper.
//
// Replaces the previous pattern of `fetch(`${event.url.origin}/api/...`)`
// with `Cookie: event.request.headers.get('Cookie')` forwarded inline. That
// pattern had two issues called out in the gap list:
//
//   1. The publisher's session cookie was forwarded to internal endpoints.
//      If a downstream endpoint ever changes its auth model, the cookie
//      flow becomes a privilege-escalation seam.
//   2. `event.url.origin` is derived from the inbound `Host:` header, which
//      is technically attacker-controllable (DNS-rebinding-adjacent).
//
// New contract:
//   - Base URL comes from a server-side env var (PUBLIC_BASE_URL — the
//     same allowlisted origin the rest of the app already trusts).
//   - Authorisation is `Bearer ${INTERNAL_PUSH_SECRET}` (per-process
//     shared secret), never the caller's cookie.
//   - The consumer route uses `constantTimeEqual` to compare the supplied
//     secret to the expected value.
//
// The Authorization header pattern (rather than the FCM endpoint's existing
// `x-internal-secret` header) was chosen by operator to match the gap-list
// recommendation verbatim and to align with the bearer-JWT path that
// hooks.server.ts already exercises for mobile/API clients.

import { env } from '$env/dynamic/private'
import { timingSafeEqual } from 'node:crypto'
import { getTenantOrNull } from '$lib/server/tenant/context'

// `PUBLIC_BASE_URL` cannot be read from `$env/dynamic/private` (the
// PUBLIC_* prefix excludes it from that module), and `$env/dynamic/public`
// is awkward in a server-only helper. We fall through to `process.env`
// directly for the base URL — this module is gated by the `lib/server/`
// path so it never runs client-side. INTERNAL_BASE_URL and
// INTERNAL_PUSH_SECRET come from the private dynamic env where supported.
//
// T14 §7.7 env-guard note: this dynamic `(env as Record<…>)[name]` read is
// invisible to the guard (the scanner matches only literal `env.<VAR>` /
// `env['<VAR>']` shapes) AND every name it ever resolves
// (INTERNAL_BASE_URL / INTERNAL_PUSH_SECRET / PUBLIC_BASE_URL /
// TENANT_PROXY_SHARED_SECRET) is a deployment-WIDE process secret, NOT a
// per-tenant variable — so it needs no allowlist entry and stays as-is.
function readEnv(name: string): string | undefined {
  const fromPrivate = (env as Record<string, string | undefined>)[name]
  if (typeof fromPrivate === 'string' && fromPrivate.length > 0) return fromPrivate
  const fromProcess = process.env[name]
  if (typeof fromProcess === 'string' && fromProcess.length > 0) return fromProcess
  return undefined
}

/**
 * Constant-time comparison helper. Used by both the producer (to vet the
 * incoming Bearer header) and the consumer (to reject a wrong secret in
 * always-equal time, defeating length/value timing leaks).
 *
 * Lengths are normalised before comparison to keep the timingSafeEqual
 * call itself well-defined — otherwise Node throws when the buffers differ.
 * The post-compare length check ensures a longer/shorter attacker string
 * never accidentally passes.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  try {
    if (typeof a !== 'string' || typeof b !== 'string') return false
    const bufA = Buffer.from(a)
    const bufB = Buffer.from(b)
    const len = Math.max(bufA.length, bufB.length)
    const paddedA = Buffer.concat([bufA, Buffer.alloc(len - bufA.length)], len)
    const paddedB = Buffer.concat([bufB, Buffer.alloc(len - bufB.length)], len)
    return timingSafeEqual(paddedA, paddedB) && a.length === b.length
  } catch {
    return false
  }
}

/**
 * Resolve the base URL for an internal call. Prefers an explicit
 * INTERNAL_BASE_URL override (used when an internal-only DNS name is
 * different from the public one) and falls back to PUBLIC_BASE_URL.
 */
function resolveInternalBaseUrl(): string {
  const internal = readEnv('INTERNAL_BASE_URL')?.trim()
  if (internal) return internal.replace(/\/$/, '')
  const pub = readEnv('PUBLIC_BASE_URL')?.trim()
  if (pub) return pub.replace(/\/$/, '')
  // Last-resort default for local dev: SvelteKit listens on :3000.
  return 'http://localhost:3000'
}

/**
 * P2.1c (T4): the registrable apex domain for tenant forwarded-host injection.
 * Derived from the host of `PUBLIC_BASE_URL` (the process-wide apex, e.g.
 * `council.example`) — the same allowlisted origin `resolveInternalBaseUrl` trusts.
 * The current tenant's slug is prepended (`<slug>.<apexDomain>`) so the inner
 * server-to-server request carries the SAME 3-label host the edge would inject,
 * which `extractLeftmostLabel` (resolve.ts) resolves back to that tenant.
 *
 * Returns `null` when PUBLIC_BASE_URL is unset/unparseable — the caller then
 * sends no tenant header (fail-soft: a missing apex must never silently widen
 * the forwarded host to an attacker-influenced value).
 */
function resolveApexDomain(): string | null {
  const pub = readEnv('PUBLIC_BASE_URL')?.trim()
  if (!pub) return null
  try {
    const host = new URL(pub).hostname
    return host.length > 0 ? host : null
  } catch {
    return null
  }
}

/**
 * Read the shared secret. Returns `null` (not '') when unset so callers
 * can distinguish "secret missing - refuse to call" from "secret is the
 * empty string". A missing secret is a configuration error and we throw
 * loudly rather than silently sending a Bearer header with no value.
 */
export function readInternalPushSecret(): string | null {
  const secret = readEnv('INTERNAL_PUSH_SECRET')
  if (typeof secret !== 'string' || secret.length === 0) return null
  return secret
}

/**
 * P2.1c (T5): the executable proxy-trust secret. When set, the tenant resolver
 * (resolve.ts) requires every edge request to carry a constant-time matching
 * `x-proxy-trust: <secret>` header that Traefik injects on the gremion-ui routers
 * — so `x-forwarded-host` trust no longer rests on network topology alone (the
 * SECURITY INVARIANT in resolve.ts). Returns `null` (not '') when unset so the
 * gate stays a byte-identical no-op (enforcement arrives at S4 deploy when the
 * operator sets this env + the Traefik label together). A different secret from
 * INTERNAL_PUSH_SECRET so the two trust domains (edge vs. self-call) rotate
 * independently.
 */
export function readProxyTrustSecret(): string | null {
  const secret = readEnv('TENANT_PROXY_SHARED_SECRET')
  if (typeof secret !== 'string' || secret.length === 0) return null
  return secret
}

export interface InternalFetchOptions extends Omit<RequestInit, 'headers'> {
  /** Additional headers to send. `Authorization` is overwritten with the
   * Bearer token; `Content-Type` defaults to `application/json` when a
   * body is present. */
  headers?: Record<string, string>
  /**
   * T16 (P1 correlation-id propagation point 2): optional correlation id to
   * forward as x-correlation-id on the outgoing self-call.  When present,
   * injected AFTER the caller-supplied headers (so the caller cannot forge
   * a different value by accident — the value here is always from a trusted
   * server-side source such as event.locals.correlationId).
   */
  correlationId?: string
}

/**
 * POST/GET/etc to an internal gremion-ui route. The `path` must start with
 * `/api/` — same-app internal calls only. Returns the raw `Response` so
 * callers retain full control over status-handling. Throws on
 * configuration errors (missing secret) — that's a programmer-fixable
 * bug, never a runtime fallback.
 */
export async function internalFetch(path: string, init: InternalFetchOptions = {}): Promise<Response> {
  if (!path.startsWith('/api/')) {
    throw new Error(`internalFetch: path must start with /api/ (got: ${path})`)
  }
  const secret = readInternalPushSecret()
  if (!secret) {
    throw new Error(
      'internalFetch: INTERNAL_PUSH_SECRET is not configured. Set it in .env and ' +
        'restart the server. The consumer route requires it to authenticate ' +
        'internal callers.',
    )
  }
  const baseUrl = resolveInternalBaseUrl()
  const headers: Record<string, string> = {
    ...(init.headers ?? {}),
    Authorization: `Bearer ${secret}`,
  }
  if (init.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }
  // P2.1c (T4): tenant-context propagation across the server-to-server hop.
  // The tenant resolver (resolve.ts) is sequence() element 0 and selects the
  // tenant from `x-forwarded-host`; ALS does NOT cross this fresh HTTP request,
  // so without re-injection the inner call would 404 (fail-closed). When this
  // call runs INSIDE a runWithTenant(ctx, …) scope we re-stamp the current
  // tenant's 3-label forwarded host + a constant-time internal-trust secret so
  // the receiver re-establishes the SAME tenant without depending on the edge
  // proxy-trust header (the resolver validates the secret in always-equal time
  // with `constantTimeEqual`). Outside any ALS scope (boot/cron callers) we
  // inject NEITHER header — those paths keep today's behavior. The injected
  // values OVERWRITE any caller-supplied ones (a caller may not forge them).
  const ctx = getTenantOrNull()
  const apexDomain = ctx ? resolveApexDomain() : null
  if (ctx && apexDomain) {
    headers['x-forwarded-host'] = `${ctx.slug}.${apexDomain}`
    headers['x-internal-host-trust'] = secret
  }
  // T16 (P1 propagation point 2): forward the request-scoped correlation id.
  // The caller passes event.locals.correlationId; the value is trusted (it was
  // already read-or-minted by correlationHandle from the original inbound
  // header) so we inject it verbatim. OVERWRITES any caller-supplied value in
  // init.headers so the server-minted id always wins over any client-supplied one.
  if (typeof init.correlationId === 'string' && init.correlationId.length > 0) {
    headers['x-correlation-id'] = init.correlationId
  }
  // Explicitly DO NOT forward `Cookie` — that's the load-bearing change.
  return fetch(`${baseUrl}${path}`, { ...init, headers })
}

/**
 * Helper for consumer routes: returns true iff the request carries a
 * valid `Authorization: Bearer ${INTERNAL_PUSH_SECRET}` header. Use this
 * to short-circuit role/session checks for trusted internal callers.
 *
 * Returns false (without throwing) when the secret is unset — that's a
 * misconfiguration the consumer can surface differently from "bad token".
 */
export function isInternalBearerRequest(request: Request): boolean {
  const expected = readInternalPushSecret()
  if (!expected) return false
  const header = request.headers.get('Authorization')
  if (!header?.startsWith('Bearer ')) return false
  const supplied = header.slice('Bearer '.length).trim()
  if (supplied.length === 0) return false
  return constantTimeEqual(supplied, expected)
}
