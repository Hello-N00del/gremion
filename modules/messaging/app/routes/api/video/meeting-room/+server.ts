// POST /api/video/meeting-room
//
// Issue #151: the dashboard "Video-Link" used to point at the STANDALONE
// element-call guest page, which 401s on createRoom because the tenant's Synapse is
// a CLOSED homeserver (no registration / no guests — only Keycloak-authenticated
// users hold a Matrix token). This route repoints the button to the working
// EMBEDDED per-room call flow: it creates (or idempotently reuses, by alias) a
// Matrix room for the meeting and ensures the caller is a member, then returns
// the roomId so the client can start the embedded Element Call widget with the
// user's own Matrix session.
import { json } from '@sveltejs/kit'
import type { RequestHandler } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { getMessagesBackend } from '$lib/server/messages/backend'

interface MeetingRoomBody {
  eventId?: string
  title?: string
}

export const POST: RequestHandler = async (event) => {
  const { locals, request } = event
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user) {
    return json({ success: false, error: 'Unauthenticated' }, { status: 401 })
  }
  // Member+ only — guests cannot create/join meeting rooms.
  if (!hasRole(user.roles, Role.Member)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  let body: MeetingRoomBody
  try {
    body = (await request.json()) as MeetingRoomBody
  } catch {
    return json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const eventId = body.eventId
  if (typeof eventId !== 'string' || eventId.trim() === '') {
    return json({ success: false, error: 'eventId is required' }, { status: 400 })
  }
  const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title : undefined

  const backend = getMessagesBackend()

  // The caller must have a real Matrix identity to join the room before the call.
  const creds = await backend.resolveMatrixCreds(event)
  if (!creds.userId || !creds.accessToken) {
    return json({ success: false, error: 'No Matrix credentials for user' }, { status: 403 })
  }

  // Stable per-meeting alias localpart → createRoom is idempotent by alias, so
  // re-clicking "Video-Link" for the same meeting reuses the same room rather
  // than minting a duplicate on the live homeserver.
  const aliasLocalpart = 'meeting-' + eventId.toLowerCase().replace(/[^a-z0-9._-]/g, '-')

  const mc = backend.matrix()
  try {
    const roomId = await mc.createRoom(
      title ?? 'Besprechung',
      `Videobesprechung – ${title ?? eventId}`,
      aliasLocalpart
    )
    // Make the caller a member before the embedded call starts: admin invites,
    // user joins. Both are idempotent (already-member is a no-op).
    await mc.inviteUser(roomId, creds.userId)
    await mc.joinRoom(creds.accessToken, roomId)

    return json({ success: true, roomId })
  } catch (err) {
    console.error('[api/video/meeting-room] failed to prepare meeting room', err)
    return json(
      { success: false, error: err instanceof Error ? err.message : 'Matrix error' },
      { status: 502 }
    )
  }
}
