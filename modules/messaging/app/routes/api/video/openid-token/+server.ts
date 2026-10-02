// GET /api/video/openid-token
// Returns the current user's Matrix user ID, the public homeserver base URL,
// and a fresh OpenID token. Used by VideoCallPip.svelte to drive element-call
// in Widget API mode — element-call requests the OpenID token via the Widget API
// fromWidget get_openid action, which the parent satisfies from this endpoint.
import { json } from '@sveltejs/kit'
import type { RequestHandler } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { defaultTenantEnv } from '$lib/server/tenant/default-env'
import { getMessagesBackend } from '$lib/server/messages/backend'

interface OpenIdToken {
  access_token: string
  token_type: string
  matrix_server_name: string
  expires_in: number
}

interface MatrixCredentials {
  userId: string
  matrixBaseUrl: string
  openidToken: OpenIdToken
}

export const GET: RequestHandler = async (event) => {
  const session = await event.locals.auth()
  const keycloakJwt = (session as unknown as { accessToken?: string })?.accessToken
  if (!keycloakJwt) return json({ error: 'Unauthenticated' }, { status: 401 })

  const matrixInternalBase = (defaultTenantEnv('MATRIX_URL') ?? 'http://matrix:8008').replace(/\/$/, '')
  const matrixPublicBase = (env.MATRIX_PUBLIC_URL ?? 'http://localhost:8009').replace(/\/$/, '')

  try {
    const matrixToken = await getMessagesBackend().matrix().getMatrixToken(keycloakJwt)

    const whoamiRes = await fetch(`${matrixInternalBase}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${matrixToken}` }
    })
    if (!whoamiRes.ok) {
      return json({ error: 'Failed to resolve Matrix user' }, { status: 502 })
    }
    const { user_id: userId } = (await whoamiRes.json()) as { user_id: string }

    const openidRes = await fetch(
      `${matrixInternalBase}/_matrix/client/v3/user/${encodeURIComponent(userId)}/openid/request_token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${matrixToken}`,
          'Content-Type': 'application/json'
        },
        body: '{}'
      }
    )
    if (!openidRes.ok) {
      return json({ error: 'Failed to get OpenID token from Matrix' }, { status: 502 })
    }
    const openidToken = (await openidRes.json()) as OpenIdToken

    const result: MatrixCredentials = { userId, matrixBaseUrl: matrixPublicBase, openidToken }
    return json(result)
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
