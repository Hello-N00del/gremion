// src/routes/api/messages/rooms/[roomId]/archive/+server.ts
//
// FLOW-MSG-001 (TASK-009 lane B, rows-plan.md row 12 / S2.5): archive an
// active room (R23-4: CouncilAdmin/ITAdmin, the normal/undoable-never path —
// hard delete is the separate ITAdmin-only DELETE route).
import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { getResource } from '$lib/server/governance/provisioning/ledger'
import { archiveRoom } from '$lib/server/messages/admin/room-admin'
import { mapRoomError } from '../../map-room-error'

const archiveSchema = z.object({ orgUnitId: z.string().min(1) })

/** POST: 404 when params.roomId does not match the unit's CURRENT ledger room
 *  — this is the same TRD-061 cross-tenant-probe shape PATCH/DELETE guard
 *  against, checked before calling into room-admin so a stale or foreign
 *  roomId in the URL can never archive the wrong room. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
  const user = locals.user as SessionUser | undefined
  if (!user) return json({ success: false, error: 'Unauthenticated' }, { status: 401 })
  if (!hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const parsed = archiveSchema.safeParse(await request.json())
  if (!parsed.success) {
    return json({ success: false, error: parsed.error.issues.map((i) => i.message).join(', ') }, { status: 400 })
  }
  const { orgUnitId } = parsed.data

  let resource: Awaited<ReturnType<typeof getResource>>
  try {
    resource = await getResource(orgUnitId, 'matrix')
  } catch (err) {
    // MEDIUM (r2-rooms-B3): same unguarded-ledger-read gap as PATCH — wrap so
    // a DB failure returns the route's normal JSON error envelope.
    return mapRoomError(err, { route: 'POST /api/messages/rooms/[roomId]/archive', orgUnitId, roomId: params.roomId, userId: user.id })
  }
  if (resource?.external_id !== params.roomId) {
    return json({ success: false, error: `room ${params.roomId} not found for unit ${orgUnitId}` }, { status: 404 })
  }

  try {
    const roomId = await archiveRoom(orgUnitId, { userId: user.id })
    return json({ success: true, data: { roomId } })
  } catch (err) {
    return mapRoomError(err, { route: 'POST /api/messages/rooms/[roomId]/archive', orgUnitId, roomId: params.roomId, userId: user.id })
  }
}
