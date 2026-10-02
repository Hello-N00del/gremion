import { error, json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestEvent, RequestHandler } from '@sveltejs/kit'
import { getMessagesBackend } from '$lib/server/messages/backend'
import { getTenant } from '$lib/server/tenant/context'
import { defaultTenantEnv } from '$lib/server/tenant/default-env'
import type { SessionUser } from '$lib/auth'
import { hasRole, Role } from '$lib/auth'
import { createRoom, getRoomArchiveMarker } from '$lib/server/messages/admin/room-admin'
import { mapRoomError } from './map-room-error'

// The CURRENT tenant's homeserver base (registry services.matrixUrl for
// non-default tenants, env fallback) — same resolution as livekit-jwt.ts
// matrixUrl() / getMatrixClient(). The per-user matrixToken is valid ONLY on
// the tenant's own Synapse; a defaultTenantEnv-only base would transmit a
// non-default tenant's token to the DEFAULT tenant's homeserver (design v11
// review, same defect class as messages/register.server.ts unread-rooms).
function matrixBase(): string {
  const ctx = getTenant()
  const svc = ctx.slug === 'default' ? undefined : ctx.services
  return (svc?.matrixUrl ?? defaultTenantEnv('MATRIX_URL') ?? 'http://matrix:8008').replace(/\/$/, '')
}

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

/** Get the Matrix user_id for an access token. */
async function getWhoAmI(matrixToken: string): Promise<string> {
  const base = matrixBase()
  const res = await fetch(`${base}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${matrixToken}` }
  })
  if (!res.ok) throw new Error(`whoami failed: ${res.status}`)
  const data = await res.json() as { user_id: string }
  return data.user_id
}

export const GET: RequestHandler = async (event) => {
  requireAuth(event)

  const mc = getMessagesBackend().matrix()
  let matrixToken: string
  try {
    const keycloakJwt = await getKeycloakJwt(event)
    matrixToken = await mc.getMatrixToken(keycloakJwt)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw error(502, `Matrix authentication failed: ${msg}`)
  }
  let joinedRooms = await mc.getJoinedRooms(matrixToken)

  // Auto-join user to all server rooms if they haven't joined any yet.
  // #370: the admin all-rooms list comes through the backend seam (the route no
  // longer fetches /_synapse/admin/v1/rooms or references SYNAPSE_ADMIN_TOKEN).
  // FLOW-MSG-001 (TASK-009 lane B, row 10): an ARCHIVED room is skipped here —
  // R23-5 "archived rooms keep members joined [from before], read-only" means
  // existing members stay, but a FRESH user must not be auto-joined into a
  // room that is no longer the unit's active room.
  if (joinedRooms.length === 0) {
    const synapse = getMessagesBackend().synapse()
    const allRooms = await synapse.listAllRoomIds()
    if (allRooms.length > 0) {
      const matrixUserId = await getWhoAmI(matrixToken)
      const joinableRooms = (
        await Promise.all(
          allRooms.map(async (roomId) => {
            // Fail CLOSED on a rejected read: a network blip or malformed
            // state-event shape must never be treated as "not archived" here
            // — that would auto-join a fresh user into a room this code's own
            // invariant (above) forbids joining them into. Skip the room and
            // log so an elevated failure rate is observable to operators.
            try {
              const archived = await getRoomArchiveMarker(roomId)
              return archived ? null : roomId
            } catch (err) {
              console.error('[messages] getRoomArchiveMarker failed during auto-join, skipping room (fail-closed)', {
                roomId, error: err instanceof Error ? err.message : String(err),
              })
              return null
            }
          })
        )
      ).filter((roomId): roomId is string => roomId !== null)
      await Promise.all(
        joinableRooms.map((roomId) =>
          synapse.forceJoinRoom(roomId, matrixUserId).catch(() => {
            // ignore — room might already be joined or restricted
          })
        )
      )
      joinedRooms = await mc.getJoinedRooms(matrixToken)
    }
  }

  // #188: real per-room unread *message* counts (excludes the invite_for_me
  // membership notification that would otherwise inflate the badge). Degrades
  // to an empty map so a /notifications hiccup can never break the room list.
  let unreadByRoom = new Map<string, number>()
  try {
    unreadByRoom = await mc.unreadMessageCountsByRoom(matrixToken)
  } catch {
    unreadByRoom = new Map()
  }

  // Fetch room name state for up to 50 rooms in parallel
  const capped = joinedRooms.slice(0, 50)
  const rooms = await Promise.all(
    capped.map(async (roomId) => {
      // FLOW-MSG-001 (TASK-009 lane B, row 10): the archived flag — the admin
      // bot's own read of the durable marker (S2.2 step 1), so this works
      // regardless of the requesting user's own room state. The flag is
      // DISPLAY-ONLY (an archived room is read-only through its Matrix power
      // levels, and every admin mutation re-reads the marker server-side).
      // TASK-009 verifier FIX 1: a REJECTED read (network blip) used to
      // degrade to archived:true, which took the composer away from every DM
      // and user room during a Matrix hiccup. It now shows the room as NOT
      // archived and logs the failure so an elevated rate stays observable.
      // (Auto-join above still fails CLOSED — joining is not display-only.)
      let archived = false
      try {
        archived = (await getRoomArchiveMarker(roomId)) !== null
      } catch (err) {
        console.error('[messages] getRoomArchiveMarker failed while listing room, showing it as not archived', {
          roomId, error: err instanceof Error ? err.message : String(err),
        })
      }
      try {
        const base = matrixBase()
        const res = await fetch(
          `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`,
          { headers: { Authorization: `Bearer ${matrixToken}` } }
        )
        const name = res.ok ? ((await res.json()) as { name?: string }).name ?? roomId : roomId
        return {
          roomId,
          name,
          unreadCount: unreadByRoom.get(roomId) ?? 0,
          lastMessageTs: 0,
          archived
        }
      } catch {
        return {
          roomId, name: roomId, unreadCount: unreadByRoom.get(roomId) ?? 0, lastMessageTs: 0,
          archived
        }
      }
    })
  )

  return json({ success: true, data: rooms })
}

const createSchema = z.object({
  orgUnitId: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
})

/** POST — create the room for an org unit (rows-plan.md S2.5). CouncilAdmin
 *  (ITAdmin inherits, lib/auth/index.ts role hierarchy). Imports ONLY
 *  room-admin, never matrix-client/synapse-admin directly (boundary rule
 *  no-messages-route-to-matrix-client, rules.ts:261). */
export const POST: RequestHandler = async (event) => {
  const user = event.locals.user as SessionUser | undefined
  if (!user) return json({ success: false, error: 'Unauthenticated' }, { status: 401 })
  if (!hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const parsed = createSchema.safeParse(await event.request.json())
  if (!parsed.success) {
    return json({ success: false, error: parsed.error.issues.map((i) => i.message).join(', ') }, { status: 400 })
  }

  try {
    const { roomId, report } = await createRoom(parsed.data.orgUnitId, {
      name: parsed.data.name, userId: user.id,
    })
    return json({ success: true, data: { roomId, report } }, { status: 201 })
  } catch (err) {
    return mapRoomError(err, {
      route: 'POST /api/messages/rooms', orgUnitId: parsed.data.orgUnitId, userId: user.id,
    })
  }
}
