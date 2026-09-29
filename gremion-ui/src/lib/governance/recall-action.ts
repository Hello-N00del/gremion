/**
 * Pure request builder for the recall ("Abberufung") action on the committee
 * roster admin surface.
 *
 * Endpoint contract (governance revoke route):
 *   POST /api/governance/committees/:id/roles/:roleId/revoke   body: { reason }
 *
 * The reason is REQUIRED — an empty or whitespace-only reason is rejected with
 * a German validation message so the UI can surface it directly.
 *
 * Both ids are interpolated through encodeURIComponent, matching the sibling
 * buildChallengePayload: they are opaque UUIDs today, so this is defensive
 * rather than a live escape, but a builder that pastes a caller-supplied value
 * into a path must never depend on that value's shape.
 */

export const RECALL_REASON_REQUIRED = 'Bitte einen Grund für die Abberufung angeben.'

export interface RevokeRequest {
  readonly url: string
  readonly method: 'POST'
  readonly body: { readonly reason: string }
}

export function buildRevokeRequest(committeeId: string, roleId: string, reason: string): RevokeRequest {
  const trimmed = reason.trim()
  if (!trimmed) throw new Error(RECALL_REASON_REQUIRED)
  return {
    url: `/api/governance/committees/${encodeURIComponent(committeeId)}/roles/${encodeURIComponent(roleId)}/revoke`,
    method: 'POST',
    body: { reason: trimmed },
  }
}
