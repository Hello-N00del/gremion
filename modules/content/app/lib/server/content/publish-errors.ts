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

/**
 * The code a leaf service answers (HTTP 409, body {"success":false,"error":"…"})
 * when the tenant id/slug pair it was called with does not match its own catalog
 * (StuRaOS#534). It is a deployment fault, not a state of the post or the channel.
 */
export const TENANT_IDENTITY_MISMATCH_CODE = 'tenant_identity_mismatch'

/** Operator-facing text; names no tenant. */
export const TENANT_IDENTITY_MISMATCH_MESSAGE =
  'Die Mandantenzuordnung des Inhaltsdienstes stimmt nicht überein. Bitte vom Betrieb prüfen lassen.'

/**
 * Thrown by the service client when the leaf refuses the call for a tenant identity
 * mismatch. Checked BEFORE the 409 -> ChannelNotPublishableError mapping, so the
 * operator is not told the channel is unpublishable when the service is misassigned.
 */
export class TenantIdentityMismatchError extends Error {
  constructor(message: string = TENANT_IDENTITY_MISMATCH_MESSAGE) {
    super(message)
    this.name = 'TenantIdentityMismatchError'
  }
}

/** True when a leaf response body is the tenant identity mismatch refusal. */
export function isTenantIdentityMismatchBody(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body)
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as { error?: unknown }).error === TENANT_IDENTITY_MISMATCH_CODE
    )
  } catch {
    return false
  }
}
