// apps/control-panel/src/hooks.server.ts — the TRD-048 gate on EVERY request.
//
// Order: securityHeaders (gremion-ui's CSP on every HTML response), then
// hostGuard (R29-I11: ORIGIN's host name only), then Auth.js and the gate.
//
// The two probes (/healthz: the process and a valid config only, so the
// panel is healthy before `gremion-tenant init`; /api/internal/evict: the
// switch's bearer-checked fan-out) bypass Auth.js entirely. Everything else
// goes through Auth.js (its own /auth/* routes) and then the gate, which
// decides before any page, form action or +server endpoint runs.
import { SvelteKitAuth } from '@auth/sveltekit'
import { redirect, type Handle, type RequestEvent } from '@sveltejs/kit'
import { sequence } from '@sveltejs/kit/hooks'
import { env } from '$env/dynamic/private'
import { authConfig, startSignIn } from '$lib/server/auth'
import { loadConfig } from '$lib/server/config'
import { decide, hostAllowed, isExempt, type SessionClaims } from '$lib/server/gate'

const SESSION_COOKIE = /^(__Secure-|__Host-)?authjs\.session-token(\.\d+)?$/

function refuse(status: number, reason: string): Response {
  return new Response(`${status} ${reason}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

const auth = SvelteKitAuth(async () => {
  const r = loadConfig(env)
  if (!r.ok) throw new Error(`the control panel is not configured: ${r.problems.join('; ')}`)
  return authConfig(r.config)
})

export const gate: Handle = async ({ event, resolve }) => {
  if (isExempt(event.url.pathname)) return resolve(event)
  const r = loadConfig(env)
  if (!r.ok) return refuse(503, 'the control panel is not configured')
  const c = r.config
  let claims: SessionClaims | null = null
  try {
    const session = await event.locals.auth()
    claims = (session as unknown as { claims?: SessionClaims } | null)?.claims ?? null
  } catch (err) {
    // Fail closed, but never silently: a rotated AUTH_SECRET, a misconfiguration
    // or a callback bug must be told apart from a forged cookie in the log.
    // The cookie value is never logged.
    const e = err as { name?: string; message?: string }
    console.error(`[control-panel] session decode failed on ${event.url.pathname}: ${e?.name ?? 'Error'}: ${e?.message ?? String(err)}`)
    claims = null
  }
  const cookies = event.cookies.getAll().filter((k) => SESSION_COOKIE.test(k.name))
  const d = decide({
    method: event.request.method,
    path: event.url.pathname,
    session: claims,
    sessionCookie: cookies.length > 0,
    authorization: event.request.headers.get('authorization'),
    issuer: c.issuer,
    requiredAcr: c.requiredAcr,
  })
  if (d.kind === 'allow') {
    event.locals.operator = d.operator
    return resolve(event)
  }
  if (d.kind === 'sign-in') {
    const location = await startSignIn(event, authConfig(c), `${event.url.pathname}${event.url.search}`, d.reason === 'step-up', env)
    // Thrown, so SvelteKit carries the state/PKCE cookies startSignIn set.
    redirect(302, location)
  }
  if (d.clearCookie) for (const k of cookies) event.cookies.delete(k.name, { path: '/' })
  return refuse(d.status, d.reason)
}

// [D R29-I11] The Content-Security-Policy gremion-ui sends (its cspGuard,
// hooks.server.ts CSP_HEADER_VALUE), verbatim: hooks.test.ts compares the two.
// The panel needs a subset of what it allows; "equal" is the operator's rule.
export const PANEL_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

function withSecurityHeaders(response: Response): Response {
  if ((response.headers.get('content-type') ?? '').startsWith('text/html')) {
    response.headers.set('Content-Security-Policy', PANEL_CSP)
  }
  // Beyond gremion-ui's set, on every response (review A LOW, r2): the
  // text/plain refusals echo request data, and an admin surface leaks no URL.
  try {
    response.headers.set('X-Content-Type-Options', 'nosniff')
    response.headers.set('Referrer-Policy', 'no-referrer')
  } catch {
    // an immutable-header response (a fetch passthrough) keeps its own headers
  }
  return response
}

export const securityHeaders: Handle = async ({ event, resolve }) => withSecurityHeaders(await resolve(event))

const isProbe = (path: string) => path === '/healthz' || path === '/api/internal/evict'

// [D R29-I11] ONE host name: every request whose Host is not ORIGIN's host is
// refused (421 Misdirected Request) before Auth.js or the gate see it. The
// probes are exempt: the container HEALTHCHECK calls 127.0.0.1:3000/healthz
// (which reports only {ok, colour}), and the evict fan-out is bearer-checked
// and refuses everything without INTERNAL_PUSH_SECRET.
function hostRefusal(event: RequestEvent): Response | null {
  if (isProbe(event.url.pathname)) return null
  const r = loadConfig(env)
  if (!r.ok) return refuse(503, 'the control panel is not configured')
  if (!hostAllowed(event.request.headers.get('host'), r.config.origin)) {
    return refuse(421, 'this panel answers only on its own host name (ORIGIN)')
  }
  // Auth.js (trustHost) builds redirect_uri and cookie flags from
  // X-Forwarded-Host when present: it must name the same host (review A, r2).
  const fwd = event.request.headers.get('x-forwarded-host')
  if (fwd !== null && !hostAllowed(fwd.split(',')[0]!.trim(), r.config.origin)) {
    return refuse(421, 'this panel answers only on its own host name (ORIGIN): X-Forwarded-Host differs')
  }
  return null
}

export const hostGuard: Handle = async ({ event, resolve }) => hostRefusal(event) ?? resolve(event)

// Not sequence(): the host guard and the headers wrap the Auth.js + gate
// sequence explicitly, so a refused Host provably never reaches Auth.js.
export const handle: Handle = async (input) => {
  const refused = hostRefusal(input.event)
  if (refused) return withSecurityHeaders(refused)
  // The probes never touch Auth.js (a missing secret must not fail /healthz).
  if (isProbe(input.event.url.pathname)) return withSecurityHeaders(await input.resolve(input.event))
  return withSecurityHeaders(await sequence(auth.handle, gate)(input))
}
