// src/routes/api/messages/rooms/[roomId]/unarchive/+server.ts
//
// Restore an archived room: the inverse of the archive route, for the room administration
// ("Verwaltung -> Räume", Archiv). CouncilAdmin/ITAdmin, like archive itself.
//
// The work is room-admin.unarchiveRoom, the same restore the Karenz of the messaging module runs:
// the room is writable again, the unit's alias is back, the ledger names the room again. It also
// decides what may be restored: only a room whose archive marker (written by the admin bot, in a
// room the admin bot created) names THIS unit, of a unit this customer has. Everything else is a
// 404, which is also what a room of another customer answers. A unit that already has another
// room is a 409.
import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { unarchiveRoom } from '$lib/server/messages/admin/room-admin'
import { mapRoomError } from '../../map-room-error'

const unarchiveSchema = z.object({ orgUnitId: z.string().min(1) })

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const user = locals.user as SessionUser | undefined
  if (!user) return json({ success: false, error: 'Unauthenticated' }, { status: 401 })
  if (!hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // A body that is not JSON is a 400 like a body without the unit, not an unhandled rejection.
  const body: unknown = await request.json().catch(() => null)
  const parsed = unarchiveSchema.safeParse(body)
  if (!parsed.success) {
    return json({ success: false, error: parsed.error.issues.map((i) => i.message).join(', ') }, { status: 400 })
  }
  const { orgUnitId } = parsed.data

  try {
    const { aliasRestored } = await unarchiveRoom(orgUnitId, params.roomId, { userId: user.id })
    return json({ success: true, data: { roomId: params.roomId, aliasRestored } })
  } catch (err) {
    return mapRoomError(err, { route: 'POST /api/messages/rooms/[roomId]/unarchive', orgUnitId, roomId: params.roomId, userId: user.id })
  }
}
