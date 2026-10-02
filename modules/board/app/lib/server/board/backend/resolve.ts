// gremion-ui/src/lib/server/board/backend/resolve.ts
// T1 — consumer-facing resolution helpers that map a backend-construction
// failure to a graceful 503 instead of an uncaught 500.
//
// getBoardBackend() (index.ts) THROWS for an unknown BOARD_BACKEND value. Every
// board consumer obtains its backend through one of these helpers so a
// misconfiguration surfaces as a retryable 503, NOT a 500 / uncaught exception.
//
//   - resolveBoardBackendOr503()  → for +server.ts handlers (return Response)
//   - resolveBoardBackendForPage() → for +page.server.ts loads (throw error())

import { error } from '@sveltejs/kit'
import { getBoardBackend, type BoardBackendPort } from './index'

const UNAVAILABLE_BODY = 'Board backend unavailable'

/**
 * API-route resolver: returns the backend, or a 503 Response when the backend
 * cannot be constructed (e.g. BOARD_BACKEND=unknown-value).
 *
 * Usage:
 *   const resolved = resolveBoardBackendOr503()
 *   if (resolved instanceof Response) return resolved
 *   const backend = resolved
 */
export function resolveBoardBackendOr503(): BoardBackendPort | Response {
  try {
    return getBoardBackend()
  } catch (err) {
    console.error('[board-backend] resolution failed → 503:', err)
    return new Response(UNAVAILABLE_BODY, {
      status: 503,
      headers: { 'Retry-After': '30' },
    })
  }
}

/**
 * Page-load resolver: returns the backend, or throws SvelteKit error(503) when
 * the backend cannot be constructed. The throw is routed to +error.svelte, so
 * the page degrades gracefully instead of rendering a 500.
 */
export function resolveBoardBackendForPage(): BoardBackendPort {
  try {
    return getBoardBackend()
  } catch (err) {
    console.error('[board-backend] resolution failed → 503:', err)
    error(503, 'Aufgabenboard momentan nicht verfügbar')
  }
}
