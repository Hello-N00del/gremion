// gremion-ui/src/lib/server/content/publish-errors.ts
// Dependency-free publish error(s) shared by the in-kernel orchestrator
// (publish.ts) AND the thin HTTP ACL client (backend/service-client.ts).
//
// This lives in its own module (not publish.ts) so the service-client can throw
// the SAME error type WITHOUT importing publish.ts — which would pull the whole
// renderer chain (getDb, sanitizer, mail, news-db) into the arm's-length HTTP
// client. Keep this file runtime-dependency-free.

/**
 * Thrown when the requested channel row is missing or disabled for the post (or
 * the post itself is unknown). The publish route maps this to a 409 — the
 * channel is not in a publishable state.
 *
 * In service mode the ServiceContentClient re-throws this on a leaf 409 so the
 * kernel route's `instanceof ChannelNotPublishableError` branch works identically
 * for both backends.
 */
export class ChannelNotPublishableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChannelNotPublishableError'
  }
}
