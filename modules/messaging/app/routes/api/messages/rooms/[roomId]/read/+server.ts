import { error, json } from '@sveltejs/kit'
import type { RequestEvent, RequestHandler } from '@sveltejs/kit'
import { z } from 'zod'
import { getMessagesBackend } from '$lib/server/messages/backend'
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

// Body is optional. The client may pass the eventId of the last message it has
// rendered; when omitted we resolve the room's most recent message event so a
// caller that doesn't track event IDs can still clear the room.
const readSchema = z.object({ eventId: z.string().min(1) }).partial()

// POST — advance the session user's read marker in a room, clearing its unread
// count. Returns 200 on success. Guarded like the sibling message routes
// (401 when unauthenticated). The shell/sidebar unread badge re-reads via
// `invalidate('app:unread')` on the client after this resolves.
export const POST: RequestHandler = async (event) => {
  requireAuth(event)

  const roomId = event.params.roomId
  if (!roomId) throw error(400, 'Missing room ID')

  // Body is optional; tolerate an empty/absent body.
  let raw: unknown = {}
  if (event.request.headers.get('content-length') !== '0') {
    try {
      raw = await event.request.json()
    } catch {
      raw = {}
    }
  }
  const parsed = readSchema.safeParse(raw)
  if (!parsed.success) throw error(422, 'Invalid body')

  const mc = getMessagesBackend().matrix()
  const keycloakJwt = await getKeycloakJwt(event)
  const matrixToken = await mc.getMatrixToken(keycloakJwt)

  // Resolve the target event: the caller's eventId, else the room's latest
  // message. If the room has no messages there's nothing to mark read.
  let eventId = parsed.data.eventId
  if (!eventId) {
    const { messages } = await mc.getMessages(matrixToken, roomId)
    eventId = messages[0]?.eventId
  }
  if (!eventId) return json({ success: true, data: { marked: false } })

  await mc.setReadMarker(matrixToken, roomId, eventId)
  return json({ success: true, data: { marked: true, eventId } })
}
