// src/lib/server/messages/auto-join.ts
//
// F1-FIX-04 (H18 / S3#25, S3#11, S1c#18; operator decision D-3): the ONE
// first-login Matrix room backfill, shared by GET /api/messages/rooms and
// GET /api/auth/matrix-token.
//
// Before: both routes (with divergent guards) listed EVERY room on the
// homeserver (synapse.listAllRoomIds) and force-joined any signed-in caller
// with zero joined rooms -- Guests included -- into all of them through the
// Synapse admin join API, which ignores join rules. Committee_only unit rooms
// were reachable that way.
//
// Now:
//   - A caller without Role.Member (a Guest) is never auto-joined.
//   - A Member is joined only to the Matrix rooms of the org units they belong
//     to: the provisioning ledger (provisioning_resources, subsystem 'matrix',
//     external_id = room id) joined with org_unit_members. That is the same
//     source the provisioning orchestrator uses for addMember, so the backfill
//     can never grant more than membership already does.
//   - An archived room is skipped, and a failed archive-marker read fails
//     CLOSED (skip + log), as before.
//   - Every failed join is logged instead of swallowed.
import { hasRole, Role } from '$lib/auth'
import { getDb } from '$lib/server/db'
import { getMessagesBackend } from './backend'
import { getRoomArchiveMarker } from './admin/room-admin'

export interface AutoJoinCaller {
  readonly id: string
  readonly roles: readonly Role[]
}

/** Matrix room ids of every org unit the user is a member of. */
export async function listOwnUnitRoomIds(userKeycloakId: string): Promise<string[]> {
  const rows = await getDb()<{ roomId: string }[]>`
    SELECT DISTINCT pr.external_id AS "roomId"
    FROM provisioning_resources pr
    JOIN org_unit_members m ON m.org_unit_id = pr.org_unit_id
    WHERE m.user_keycloak_id = ${userKeycloakId}
      AND pr.subsystem = 'matrix'
      AND pr.external_id IS NOT NULL`
  return rows.map((r) => r.roomId)
}

/** Join a first-login caller to the rooms of their own org units. Returns the
 *  room ids a join was attempted for. Never throws for a single room.
 *  `resolveMatrixUserId` is only called when there is a room to join. */
export async function autoJoinOwnUnitRooms(
  caller: AutoJoinCaller,
  resolveMatrixUserId: () => Promise<string>,
  logTag: string,
): Promise<string[]> {
  if (!hasRole([...caller.roles], Role.Member)) return []
  let candidates: string[]
  try {
    candidates = await listOwnUnitRoomIds(caller.id)
  } catch (err) {
    // Fail closed: no membership answer means no join; the room list still loads.
    console.error(`[${logTag}] own-unit room lookup failed, skipping auto-join`, {
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
  if (candidates.length === 0) return []

  const joinable = (
    await Promise.all(
      candidates.map(async (roomId) => {
        try {
          return (await getRoomArchiveMarker(roomId)) ? null : roomId
        } catch (err) {
          console.error(`[${logTag}] getRoomArchiveMarker failed during auto-join, skipping room (fail-closed)`, {
            roomId, error: err instanceof Error ? err.message : String(err),
          })
          return null
        }
      }),
    )
  ).filter((roomId): roomId is string => roomId !== null)
  if (joinable.length === 0) return []

  const matrixUserId = await resolveMatrixUserId()
  const synapse = getMessagesBackend().synapse()
  await Promise.all(
    joinable.map((roomId) =>
      synapse.forceJoinRoom(roomId, matrixUserId).catch((err: unknown) => {
        console.warn(`[${logTag}] auto-join into own unit room failed`, {
          roomId, error: err instanceof Error ? err.message : String(err),
        })
      }),
    ),
  )
  return joinable
}
