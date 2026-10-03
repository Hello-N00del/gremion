// gremion-ui/src/lib/server/elections/backend/resolve.ts
// Consumer-facing resolution helper that maps a backend-construction failure to
// a graceful 503 instead of an uncaught 500.
//
// Why: getVotesBackend() (index.ts) THROWS for an unknown VOTES_BACKEND value.
// A consumer that must degrade rather than 500 obtains its backend through this
// helper so a misconfiguration (or any other backend-construction error) surfaces
// as a retryable 503. With VOTES_BACKEND unset (the flag-OFF default) construction
// always succeeds, so this is byte-identical to the pre-seam route at runtime.

import { getVotesBackend, type VotesBackendPort, type GetVotesBackendOptions } from './index'

/** Body returned by the 503. */
const UNAVAILABLE_BODY = 'Votes backend unavailable'

/**
 * Resolver: returns the backend, or a 503 Response when the backend cannot be
 * constructed (e.g. VOTES_BACKEND=unknown-value).
 *
 * Usage:
 *   const resolved = resolveVotesBackendOr503()
 *   if (resolved instanceof Response) return resolved
 *   const backend = resolved
 */
export function resolveVotesBackendOr503(
  opts: GetVotesBackendOptions = {},
): VotesBackendPort | Response {
  try {
    return getVotesBackend(opts)
  } catch (err) {
    console.error('[votes-backend] resolution failed → 503:', err)
    return new Response(UNAVAILABLE_BODY, {
      status: 503,
      headers: { 'Retry-After': '30' },
    })
  }
}
