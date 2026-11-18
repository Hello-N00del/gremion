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

import { error, json } from '@sveltejs/kit'
import { getBoardBackend, type BoardBackendPort } from './index'
import { BoardUnavailableError } from './location'

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
 * The router builds fine and fails per call: a write during a move, or a location flag that
 * cannot be read, throws BoardUnavailableError from the backend's method (location.ts), not
 * from getBoardBackend(). Wrap every board handler with one of the two helpers below so that
 * becomes a 503 and never a 500; anything else passes through untouched (a SvelteKit
 * error(403|404|400), a real bug). The cause of the failure stays in the server log and is
 * never put into the response.
 */
export function mapBoardUnavailable<A extends unknown[]>(
  handler: (...args: A) => Promise<Response> | Response,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args)
    } catch (err) {
      if (err instanceof BoardUnavailableError) {
        return json({ message: err.message }, { status: 503, headers: { 'Retry-After': String(err.retryAfterSeconds) } })
      }
      throw err
    }
  }
}

/** The page-load twin of mapBoardUnavailable: error(503) with the German text, which SvelteKit
 *  routes to +error.svelte. */
export function mapBoardUnavailableForPage<A extends unknown[], R>(handler: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await handler(...args)
    } catch (err) {
      if (err instanceof BoardUnavailableError) error(503, err.message)
      throw err
    }
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
