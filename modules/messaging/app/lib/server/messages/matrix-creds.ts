// Shared helper: resolve the caller's Matrix credentials (userId + access token)
// from their Keycloak session JWT.
//
// Both /api/video/token and /api/video/meeting-room need to turn the session's
// Keycloak access token into the *user's own* Matrix token (via the JWT login
// flow) and resolve their Matrix user id (via /account/whoami). Factored here so
// the two routes share one implementation instead of drifting copies.
//
// resolveMatrixCreds is deliberately "soft": on any failure it returns empty
// strings rather than throwing, so /api/video/token can still mint a LiveKit
// token and let element-call prompt for login. Callers that REQUIRE Matrix
// membership (meeting-room) must check for an empty userId and reject (403).
import { error } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { defaultTenantEnv } from '$lib/server/tenant/default-env'
import { getMatrixClient } from '$lib/server/messages/matrix-client'

/** Extract the Keycloak access token from the Authorization header or session. */
export async function getKeycloakJwt(event: RequestEvent): Promise<string> {
  const authHeader = event.request.headers.get('Authorization')
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7)
  const session = await event.locals.auth()
  const accessToken = (session as unknown as { accessToken?: string })?.accessToken
  if (!accessToken) throw error(401, 'No Keycloak access token in session')
  return accessToken
}

export interface MatrixCreds {
  userId: string
  accessToken: string
}

/**
 * Resolve the caller's Matrix user id + access token from their Keycloak session.
 * Returns `{ userId: '', accessToken: '' }` on any failure (never throws) so the
 * token route can degrade gracefully. Callers requiring real creds must check
 * `userId` for emptiness.
 */
export async function resolveMatrixCreds(event: RequestEvent): Promise<MatrixCreds> {
  try {
    const jwt = await getKeycloakJwt(event)
    const matrixToken = await getMatrixClient().getMatrixToken(jwt)
    const base = (defaultTenantEnv('MATRIX_URL') ?? 'http://matrix:8008').replace(/\/$/, '')
    const res = await fetch(`${base}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${matrixToken}` },
    })
    if (res.ok) {
      const data = (await res.json()) as { user_id?: string }
      if (data.user_id) return { userId: data.user_id, accessToken: matrixToken }
    }
  } catch {
    // Fall through — Matrix creds unavailable, caller decides how to degrade.
  }
  return { userId: '', accessToken: '' }
}
