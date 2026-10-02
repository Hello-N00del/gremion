// gremion-ui/src/lib/server/messages/backend/resolve.ts
// Consumer-facing resolution helper that maps a backend-construction failure to
// a graceful 503 instead of an uncaught 500.
//
// Why: getMessagesBackend() (index.ts) THROWS for an unknown MESSAGES_BACKEND
// value. A messages+video route can obtain its backend through this helper so a
// misconfiguration surfaces as a 503 the client can retry, NOT a 500. With
// MESSAGES_BACKEND unset (the flag-OFF default) construction always succeeds, so
// this is byte-identical to the pre-seam route at runtime.

import { getMessagesBackend, type MessagesBackendPort, type GetMessagesBackendOptions } from './index'

/** Body returned by the API 503. */
const UNAVAILABLE_BODY = 'Messages backend unavailable'

/**
 * API-route resolver: returns the backend, or a 503 Response when the backend
 * cannot be constructed (e.g. MESSAGES_BACKEND=unknown-value).
 *
 * Usage:
 *   const resolved = resolveMessagesBackendOr503()
 *   if (resolved instanceof Response) return resolved
 *   const backend = resolved
 */
export function resolveMessagesBackendOr503(
  opts: GetMessagesBackendOptions = {},
): MessagesBackendPort | Response {
  try {
    return getMessagesBackend(opts)
  } catch (err) {
    console.error('[messages-backend] resolution failed → 503:', err)
    return new Response(UNAVAILABLE_BODY, {
      status: 503,
      headers: { 'Retry-After': '30' },
    })
  }
}
