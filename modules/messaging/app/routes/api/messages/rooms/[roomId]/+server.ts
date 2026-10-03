// src/routes/api/messages/rooms/[roomId]/+server.ts
//
// FLOW-MSG-001 (TASK-009 lane B, rows-plan.md row 11 / S2.5): rename/retopic
// (PATCH) and hard delete (DELETE) of a Gremion-managed room. Both import ONLY
// room-admin (+ ledger.getResource, which is governance-side, not a
// matrix/synapse client — the no-messages-route-to-matrix-client boundary
// rule only forbids importing matrix-client/synapse-admin/etc directly here).
import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { getResource } from '$lib/server/governance/provisioning/ledger'
import {
  renameRoom, deleteRoom, getRoomArchiveMarker,
} from '$lib/server/messages/admin/room-admin'
import { mapRoomError } from '../map-room-error'

const patchSchema = z.object({
  orgUnitId: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
  topic: z.string().max(1000).optional(),
})

/** PATCH: rename/retopic an ACTIVE room. Distinguishes (rows-plan.md B2 note,
 *  assigned to this route) a roomId that never belonged to this unit (404 —
 *  also the TRD-061 cross-tenant-probe shape: another tenant's roomId never
 *  matches this tenant's ledger OR its Matrix archive marker) from a roomId
 *  that DID belong to this unit but was archived (409 — archived rooms are
 *  read-only per FLOW/R23-5, no rename). */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  const user = locals.user as SessionUser | undefined
  if (!user) return json({ success: false, error: 'Unauthenticated' }, { status: 401 })
  if (!hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const parsed = patchSchema.safeParse(await request.json())
  if (!parsed.success) {
    return json({ success: false, error: parsed.error.issues.map((i) => i.message).join(', ') }, { status: 400 })
  }
  const { orgUnitId, name, topic } = parsed.data

  let resource: Awaited<ReturnType<typeof getResource>>
  try {
    resource = await getResource(orgUnitId, 'matrix')
  } catch (err) {
    // MEDIUM (r2-rooms-B3): this ledger read is a DB round-trip like any
    // other in the route — an unguarded rejection here would bypass the
    // route's own {success:false,error} JSON contract and fall through to
    // SvelteKit's generic (non-JSON) 500.
    return mapRoomError(err, { route: 'PATCH /api/messages/rooms/[roomId]', orgUnitId, roomId: params.roomId, userId: user.id })
  }
  if (resource?.external_id !== params.roomId) {
    const marker = await getRoomArchiveMarker(params.roomId).catch(() => null)
    if (marker?.org_unit_id === orgUnitId) {
      return json({ success: false, error: 'room is archived' }, { status: 409 })
    }
    return json({ success: false, error: `room ${params.roomId} not found for unit ${orgUnitId}` }, { status: 404 })
  }

  try {
    await renameRoom(orgUnitId, { name, topic, userId: user.id })
    return json({ success: true, data: null })
  } catch (err) {
    return mapRoomError(err, { route: 'PATCH /api/messages/rooms/[roomId]', orgUnitId, roomId: params.roomId, userId: user.id })
  }
}

/** DELETE ?orgUnitId=<unit> — ITAdmin only (R23-4: hard delete is the
 *  ITAdmin-only path, no step-up per rows-plan.md S2.5 — the comparable
 *  destructive action, committee DELETE, already purges with a role check
 *  only). room-admin.deleteRoom itself authorizes an archived room's delete
 *  against its own marker, so no extra check is needed here. */
export const DELETE: RequestHandler = async ({ params, url, locals }) => {
  const user = locals.user as SessionUser | undefined
  if (!user) return json({ success: false, error: 'Unauthenticated' }, { status: 401 })
  if (!hasRole(user.roles, Role.ITAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const orgUnitId = url.searchParams.get('orgUnitId')
  if (!orgUnitId) return json({ success: false, error: 'orgUnitId is required' }, { status: 400 })

  try {
    await deleteRoom(orgUnitId, params.roomId, { userId: user.id })
    return json({ success: true, data: null })
  } catch (err) {
    return mapRoomError(err, { route: 'DELETE /api/messages/rooms/[roomId]', orgUnitId, roomId: params.roomId, userId: user.id })
  }
}
