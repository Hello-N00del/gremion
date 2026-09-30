// apps/control-panel/src/hooks.server.ts — the TRD-048 gate on EVERY request.
//
// The two probes (/healthz: the process and a valid config only, so the
// panel is healthy before `gremion-tenant init`; /api/internal/evict: the
// switch's bearer-checked fan-out) bypass Auth.js entirely. Everything else
// goes through Auth.js (its own /auth/* routes) and then the gate, which
// decides before any page, form action or +server endpoint runs.
import { SvelteKitAuth } from '@auth/sveltekit'
import { redirect, type Handle } from '@sveltejs/kit'
import { sequence } from '@sveltejs/kit/hooks'
import { env } from '$env/dynamic/private'
import { authConfig, startSignIn } from '$lib/server/auth'
import { loadConfig } from '$lib/server/config'
import { decide, isExempt, type SessionClaims } from '$lib/server/gate'

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
  } catch {
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

export const handle: Handle = async (input) => {
  // The probes never touch Auth.js (a missing secret must not fail /healthz).
  if (input.event.url.pathname === '/healthz' || input.event.url.pathname === '/api/internal/evict') return input.resolve(input.event)
  return sequence(auth.handle, gate)(input)
}
