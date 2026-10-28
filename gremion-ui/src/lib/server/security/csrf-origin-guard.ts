import type { Handle } from '@sveltejs/kit'
import { requestPath } from '$lib/server/request-path'

// CSRF defence for the cookie-authenticated JSON API.
//
// SvelteKit's own CSRF check (kit respond.js) only covers form content types
// (application/x-www-form-urlencoded, multipart/form-data, text/plain). A
// cross-site POST with NO Content-Type, or one a fetch() sends with a
// no-preflight type, skips it, and `request.json()` still parses the body. The
// Auth.js session cookie is SameSite=Lax, which is "same-SITE", not
// same-origin: script planted on a sibling tenant under the same registrable
// domain sends the cookie. So every cookie-session, state-changing /api/
// request must prove it came from this very origin:
//
//   1. `Origin` present  -> must equal the request's own origin (event.url.origin).
//      The app deliberately leaves ORIGIN unset (multi-tenant, see
//      docker-compose.app.yml), so adapter-node builds event.url from the real
//      inbound Host and x-forwarded-proto; the tenant resolver cross-checks that
//      Host against the edge-pinned x-forwarded-host. That is the tenant origin.
//   2. `Origin` absent   -> `Sec-Fetch-Site` must be `same-origin`.
//   3. neither           -> refuse. Every browser sends one of them on a
//      non-GET request, so only a non-browser client lacks both.
//
// Exempt: Bearer requests (JWT or the internal push secret; a cross-site page
// cannot attach an Authorization header it does not hold, and the browser never
// adds one on its own), requests with no Cookie header (there is no session to
// ride), and the safe methods.

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function refuse(reason: string): Response {
  return new Response(JSON.stringify({ error: 'Forbidden', reason }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  })
}

export const csrfOriginGuard: Handle = ({ event, resolve }) => {
  const { request } = event
  if (!MUTATING.has(request.method.toUpperCase())) return resolve(event)
  if (!requestPath(event).startsWith('/api/')) return resolve(event)
  if (/^Bearer /i.test(request.headers.get('authorization') ?? '')) return resolve(event)
  if (!request.headers.get('cookie')) return resolve(event)

  const origin = request.headers.get('origin')
  if (origin !== null) {
    return origin === event.url.origin ? resolve(event) : refuse('csrf_origin_mismatch')
  }
  return request.headers.get('sec-fetch-site') === 'same-origin' ? resolve(event) : refuse('csrf_origin_missing')
}
