import { error, json } from '@sveltejs/kit'
import type { RequestEvent, RequestHandler } from '@sveltejs/kit'
import { z } from 'zod'
import { getMessagesBackend, type MatrixClientPort } from '$lib/server/messages/backend'
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

async function getTokenForEvent(event: RequestEvent): Promise<{ mc: MatrixClientPort; matrixToken: string; user: SessionUser }> {
  const user = requireAuth(event)
  const mc = getMessagesBackend().matrix()
  const keycloakJwt = await getKeycloakJwt(event)
  const matrixToken = await mc.getMatrixToken(keycloakJwt)
  return { mc, matrixToken, user }
}

export const GET: RequestHandler = async (event) => {
  requireAuth(event)
  const { mc, matrixToken } = await getTokenForEvent(event)
  const roomId = event.params.roomId
  if (!roomId) throw error(400, 'Missing room ID')

  // Validate room membership
  const joinedRooms = await mc.getJoinedRooms(matrixToken)
  if (!joinedRooms.includes(roomId)) throw error(403, 'Not a member of this room')

  const from = event.url.searchParams.get('from') ?? undefined
  const { messages, end } = await mc.getMessages(matrixToken, roomId, from)

  // Rewrite any mxc:// URLs to the proxy endpoint
  const rewritten = messages.map((m) => {
    if (m.url?.startsWith('mxc://')) {
      return { ...m, url: `/api/messages/rooms/${encodeURIComponent(roomId)}/media?mxc=${encodeURIComponent(m.url)}` }
    }
    return m
  })

  return json({ success: true, data: { messages: rewritten, end } })
}

const messageSchema = z.object({
  body: z.string().min(1).max(32768)
})

export const POST: RequestHandler = async (event) => {
  requireAuth(event)
  const { mc, matrixToken } = await getTokenForEvent(event)
  const roomId = event.params.roomId
  if (!roomId) throw error(400, 'Missing room ID')

  let body: unknown
  try {
    body = await event.request.json()
  } catch {
    throw error(400, 'Invalid JSON')
  }

  const result = messageSchema.safeParse(body)
  if (!result.success) {
    throw error(422, result.error.issues.map((i) => i.message).join(', '))
  }

  const eventId = await mc.sendMessage(matrixToken, roomId, {
    msgtype: 'm.text',
    body: result.data.body
  })

  return json({ success: true, data: { eventId } })
}
