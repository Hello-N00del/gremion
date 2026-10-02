// gremion-ui/src/lib/server/calendar/backend/resolve.ts
// Task 5 — consumer-facing resolution helpers that map a backend-construction
// failure to a graceful 503 instead of an uncaught 500.
//
// Why: getCalendarBackend() (index.ts) THROWS for an unknown CALENDAR_BACKEND
// value. Every calendar consumer obtains its backend through one of these
// helpers so that a misconfiguration (or any other backend-construction error)
// surfaces as a 503 the client can retry, NOT a 500 / uncaught exception.
//
// Two shapes:
//   - resolveCalendarBackendOr503()  → for +server.ts handlers (return Response)
//   - resolveCalendarBackendForPage() → for +page.server.ts loads (throw error())

import { error } from '@sveltejs/kit'
import { getCalendarBackend, type CalendarBackendPort } from './index'

/** Body returned by the API 503 — mirrors the existing calendarGuard 503. */
const UNAVAILABLE_BODY = 'Calendar backend unavailable'

/**
 * API-route resolver: returns the backend, or a 503 Response when the backend
 * cannot be constructed (e.g. CALENDAR_BACKEND=unknown-value).
 *
 * Usage:
 *   const resolved = resolveCalendarBackendOr503()
 *   if (resolved instanceof Response) return resolved
 *   const backend = resolved
 */
export function resolveCalendarBackendOr503(): CalendarBackendPort | Response {
  try {
    return getCalendarBackend()
  } catch (err) {
    console.error('[calendar-backend] resolution failed → 503:', err)
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
export function resolveCalendarBackendForPage(): CalendarBackendPort {
  try {
    return getCalendarBackend()
  } catch (err) {
    console.error('[calendar-backend] resolution failed → 503:', err)
    error(503, 'Kalender momentan nicht verfügbar')
  }
}
