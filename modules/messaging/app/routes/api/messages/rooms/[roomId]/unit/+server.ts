// src/routes/api/messages/rooms/[roomId]/unit/+server.ts
//
// TASK-009 lane B (row 15): resolves an active/archived room's owning org
// unit, so the /messages "Einstellungen" panel can call PATCH/archive/DELETE
// (all orgUnitId-scoped, rows-plan.md S2.5) from a room the chat page only
// otherwise knows by roomId. CouncilAdmin-gated — same role as those routes.
import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { findUnitIdForRoom } from '$lib/server/messages/admin/room-admin'

export const GET: RequestHandler = async ({ params, locals }) => {
  const user = locals.user as SessionUser | undefined
  if (!user) return json({ success: false, error: 'Unauthenticated' }, { status: 401 })
  if (!hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const orgUnitId = await findUnitIdForRoom(params.roomId)
  if (!orgUnitId) {
    return json({ success: false, error: `no unit owns room ${params.roomId}` }, { status: 404 })
  }
  return json({ success: true, data: { orgUnitId } })
}
