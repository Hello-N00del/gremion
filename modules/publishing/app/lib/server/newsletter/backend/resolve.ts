// gremion-ui/src/lib/server/newsletter/backend/resolve.ts
// Task 13 — consumer-facing resolution helpers that map a backend-construction
// failure to a graceful 503 instead of an uncaught 500.
//
// Why: getNewsletterBackend() (index.ts) THROWS for an unknown NEWSLETTER_BACKEND
// value. Every newsletter consumer obtains its backend through one of these
// helpers so that a misconfiguration (or any other backend-construction error)
// surfaces as a 503 the client can retry, NOT a 500 / uncaught exception.
//
// Task 23 (old-path decommission): the DEFAULT is now 'service' — the only
// backend is the HTTP ACL to the newsletter leaf. getNewsletterBackend()
// constructs the ServiceNewsletterClient synchronously without throwing, so
// these helpers hand the same instance straight back; the 503 path is reserved
// for a misconfigured NEWSLETTER_BACKEND value.
//
// Two shapes:
//   - resolveNewsletterBackendOr503()  → for +server.ts handlers (return Response)
//   - resolveNewsletterBackendForPage() → for +page.server.ts loads (throw error())

import { error } from '@sveltejs/kit'
import { getNewsletterBackend, type NewsletterBackendPort } from './index'

/** Body returned by the API 503 — mirrors the existing newsletterGuard 503. */
const UNAVAILABLE_BODY = 'Newsletter backend unavailable'

/**
 * API-route resolver: returns the backend, or a 503 Response when the backend
 * cannot be constructed (e.g. NEWSLETTER_BACKEND=service before Task 14).
 *
 * Usage:
 *   const resolved = resolveNewsletterBackendOr503()
 *   if (resolved instanceof Response) return resolved
 *   const backend = resolved
 */
export function resolveNewsletterBackendOr503(): NewsletterBackendPort | Response {
  try {
    return getNewsletterBackend()
  } catch (err) {
    console.error('[newsletter-backend] resolution failed → 503:', err)
    return new Response(UNAVAILABLE_BODY, {
      status: 503,
      headers: { 'Retry-After': '30' },
    })
  }
}

/**
 * Page-load resolver: returns the backend, or throws SvelteKit error(503) when
 * the backend cannot be constructed. The throw is routed to +error.svelte by
 * SvelteKit (load-throw → error page), so the page degrades gracefully instead
 * of rendering a 500.
 */
export function resolveNewsletterBackendForPage(): NewsletterBackendPort {
  try {
    return getNewsletterBackend()
  } catch (err) {
    console.error('[newsletter-backend] resolution failed → 503:', err)
    error(503, 'Newsletter momentan nicht verfügbar')
  }
}
