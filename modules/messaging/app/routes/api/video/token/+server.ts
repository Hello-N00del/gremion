import { json } from '@sveltejs/kit'
import type { RequestHandler } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { getMessagesBackend } from '$lib/server/messages/backend'

interface TokenRequestBody {
  roomType?: 'room' | 'dm'
  matrixRoomId?: string
  peerMatrixId?: string
}

export const POST: RequestHandler = async (event) => {
  const { locals, request, cookies } = event
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user) {
    return json({ success: false, error: 'Unauthenticated' }, { status: 403 })
  }

  let body: TokenRequestBody
  try {
    body = (await request.json()) as TokenRequestBody
  } catch {
    return json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const roomType = body.roomType
  if (roomType !== 'room' && roomType !== 'dm') {
    return json({ success: false, error: 'roomType must be "room" or "dm"' }, { status: 400 })
  }

  const isGuest = !hasRole(user.roles, Role.Member)
  // Guests can only publish on DM calls — subscribe-only for room calls.
  const canPublish = roomType === 'dm' ? true : !isGuest

  const backend = getMessagesBackend()
  const lk = backend.livekit()
  const matrixCreds = await backend.resolveMatrixCreds(event)
  const matrixUserId = matrixCreds.userId

  let roomName: string
  if (roomType === 'room') {
    const matrixRoomId = body.matrixRoomId
    if (typeof matrixRoomId !== 'string' || !matrixRoomId.startsWith('!')) {
      return json(
        { success: false, error: 'matrixRoomId must be a valid Matrix room ID' },
        { status: 400 },
      )
    }
    // #257-1 (video parity): a room-pinned LiveKit token grants join/subscribe (and
    // publish for members) on a specific Matrix room. Gate it on confirmed room
    // membership — exactly as handleSfuRequest gates the SFU publish token — so no
    // authed user can mint a join/eavesdrop token for a private room they are not
    // in. FAIL CLOSED: an empty/unresolved matrixUserId (resolveMatrixCreds is soft)
    // or a non-member is rejected.
    if (!matrixUserId || !(await backend.synapse().isRoomMember(matrixRoomId, matrixUserId))) {
      return json(
        { success: false, error: 'Not a member of this room' },
        { status: 403 },
      )
    }
    roomName = lk.roomNameFromMatrixId(matrixRoomId)
  } else {
    // 'dm' branch: intentionally NOT membership-gated. dmRoomName always embeds the
    // caller's own id (matrixUserId || user.name || 'self'), so a caller can only
    // ever derive the LiveKit room for a DM they are themselves a party to — a
    // documented design decision (#257-1 scope is room calls only).
    const peerMatrixId = body.peerMatrixId
    if (typeof peerMatrixId !== 'string' || !peerMatrixId.startsWith('@')) {
      return json(
        { success: false, error: 'peerMatrixId must be a valid Matrix user ID' },
        { status: 400 },
      )
    }
    roomName = lk.dmRoomName(matrixUserId || user.name || 'self', peerMatrixId)
  }

  const identity = matrixUserId || user.name || 'unknown'
  let token: string
  try {
    token = await lk.mintToken({
      roomName,
      identity,
      displayName: user.name ?? 'Unbekannt',
      canPublish,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token-Generierung fehlgeschlagen'
    return json({ success: false, error: message }, { status: 503 })
  }

  // G-022: matrix access token leaves the server as an HttpOnly cookie,
  // not in the JSON response body. Scoped to /matrix so it is never sent
  // on other API calls. Set only when creds resolved; an empty token would
  // shadow a previously-set valid cookie.
  if (matrixCreds.accessToken) {
    cookies.set('matrix_access', matrixCreds.accessToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/matrix',
      maxAge: 3600,
    })
  }

  return json({
    success: true,
    token,
    roomName,
    matrixUserId: matrixCreds.userId || null,
  })
}
