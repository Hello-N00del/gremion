import { error } from '@sveltejs/kit'
import type { RequestEvent, RequestHandler } from '@sveltejs/kit'
import { z } from 'zod'
import { getMessagesBackend } from '$lib/server/messages/backend'
import { defaultTenantEnv } from '$lib/server/tenant/default-env'
import type { SessionUser } from '$lib/auth'

function requireAuth(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  return user
}

async function getKeycloakJwt(event: RequestEvent): Promise<string> {
  const authHeader = event.request.headers.get('Authorization')
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7)
  const session = await event.locals.auth()
  const accessToken = (session as unknown as { accessToken?: string })?.accessToken
  if (!accessToken) throw error(401, 'No Keycloak access token in session')
  return accessToken
}

async function getWhoAmI(matrixToken: string): Promise<string> {
  const base = (defaultTenantEnv('MATRIX_URL') ?? 'http://matrix:8008').replace(/\/$/, '')
  const res = await fetch(`${base}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${matrixToken}` }
  })
  if (!res.ok) return ''
  const data = await res.json() as { user_id: string }
  return data.user_id
}

const typingSchema = z.object({ typing: z.boolean() })

export const PUT: RequestHandler = async (event) => {
  requireAuth(event)

  let body: unknown
  try {
    body = await event.request.json()
  } catch {
    throw error(400, 'Invalid JSON')
  }

  const result = typingSchema.safeParse(body)
  if (!result.success) throw error(422, 'Invalid body')

  const mc = getMessagesBackend().matrix()
  const keycloakJwt = await getKeycloakJwt(event)
  const matrixToken = await mc.getMatrixToken(keycloakJwt)
  const matrixUserId = await getWhoAmI(matrixToken)

  const roomId = event.params.roomId
  if (!roomId) throw error(400, 'Missing room ID')

  if (matrixUserId) {
    await mc.sendTyping(matrixToken, roomId, matrixUserId, result.data.typing)
  }

  return new Response(null, { status: 204 })
}
