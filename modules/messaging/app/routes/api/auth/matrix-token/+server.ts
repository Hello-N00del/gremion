import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { defaultTenantEnv } from '$lib/server/tenant/default-env'
import { getMessagesBackend } from '$lib/server/messages/backend'

/**
 * GET /api/auth/matrix-token
 *
 * Exchange the caller's Keycloak Bearer JWT for a Synapse access token.
 * The mobile app calls this once after login and stores the result in
 * SecureStorage so the Matrix SDK can be initialised with a real token.
 *
 * Authentication: Bearer <keycloak-access-token> header (validated in hooks.server.ts).
 */
export const GET: RequestHandler = async ({ request, url, locals }) => {
  // hooks.server.ts has already validated the Bearer token and set locals.user.
  const user = locals.user
  if (!user) {
    return json({ success: false, error: 'Unauthenticated' }, { status: 401 })
  }

  // Extract the raw Keycloak JWT from the Authorization header — getMatrixToken
  // needs it to pass directly to Synapse's org.matrix.login.jwt endpoint.
  const authHeader = request.headers.get('Authorization') ?? ''
  const keycloakJwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!keycloakJwt) {
    return json({ success: false, error: 'No Bearer token provided' }, { status: 401 })
  }

  // If the client provides its existing device_id, pass it to Synapse so the
  // same device is reused rather than a new one being created on every refresh.
  const existingDeviceId = url.searchParams.get('device_id') ?? undefined

  try {
    const matrixToken = await getMessagesBackend().matrix().getMatrixToken(keycloakJwt, existingDeviceId)

    // Ask Synapse for the actual user ID — JWT exchange creates users with UUID localparts
    // (based on Keycloak sub), so we cannot derive the ID from preferredUsername.
    const matrixBase = (defaultTenantEnv('MATRIX_URL') ?? 'http://matrix:8008').replace(/\/$/, '')
    let matrixUserId: string
    let matrixDeviceId: string = ''
    try {
      const whoAmI = await fetch(`${matrixBase}/_matrix/client/v3/account/whoami`, {
        headers: { Authorization: `Bearer ${matrixToken}` }
      })
      const whoData = await whoAmI.json() as { user_id?: string; device_id?: string }
      matrixUserId = whoData.user_id ?? ''
      matrixDeviceId = whoData.device_id ?? ''
    } catch {
      // Fall back to username-based ID if whoAmI fails (non-fatal)
      const matrixServerName = defaultTenantEnv('SYNAPSE_SERVER_NAME') ?? 'localhost'
      matrixUserId = `@${user.preferredUsername ?? user.id}:${matrixServerName}`
    }

    // Auto-join new users to all rooms (fire-and-forget — never fails the token exchange)
    if (matrixUserId) {
      const backend = getMessagesBackend()
      const mc = backend.matrix()
      const synapse = backend.synapse()
      mc.getJoinedRooms(matrixToken)
        .then(async (joined) => {
          if (joined.length === 0) {
            // #370: the admin all-rooms list comes through the backend seam
            // (SYNAPSE_ADMIN_TOKEN stays in the backend / leaf; per-tenant token).
            const allRoomIds = await synapse.listAllRoomIds()
            await Promise.all(
              allRoomIds.map((roomId) =>
                synapse.forceJoinRoom(roomId, matrixUserId).catch(() => undefined)
              )
            )
          }
        })
        .catch(() => undefined) // non-fatal
    }

    return json({
      success: true,
      data: {
        matrixToken,
        matrixUserId,
        matrixDeviceId,
      }
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return json({ success: false, error: `Matrix token exchange failed: ${msg}` }, { status: 502 })
  }
}
