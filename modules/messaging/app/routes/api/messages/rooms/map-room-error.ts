// src/routes/api/messages/rooms/map-room-error.ts
//
// FLOW-MSG-001 (TASK-009 lane B, rows-plan.md S2.5): shared error->HTTP-status
// mapping for the three admin-mutation routes (POST create, PATCH rename,
// POST archive, DELETE). Not a route file (no +server.ts / +page.* prefix), so
// SvelteKit's router ignores it — a plain module-internal helper, same as any
// other file under src/routes that isn't itself a route entry point.
//
// Every admin-mutation route imports ONLY room-admin (+ this helper, which
// itself imports nothing from matrix-client/synapse-admin) — the
// no-messages-route-to-matrix-client boundary rule (rules.ts:261) stays intact.
import { json } from '@sveltejs/kit'
import {
  MatrixUnavailableError, RoomConflictError, RoomNotFoundError,
} from '$lib/server/messages/admin/room-admin'

/** Route/unit/room/user context a call site can attach so a mutation failure
 *  is diagnosable server-side (MEDIUM, r2-rooms-B3: this function never
 *  logged anything before turning an error into a response, so admin-mutation
 *  failures across create/rename/archive/delete were visible only in the
 *  client's JSON body, never in server logs). */
export interface RoomErrorContext {
  route?: string
  orgUnitId?: string
  roomId?: string
  userId?: string
}

/** 503 (transport outage, PRD-DEP-002 banner) / 409 (conflict) / 404 (not
 *  found, incl. a roomId that does not belong to this unit — TRD-061
 *  cross-tenant probe) / 502 (any other upstream Matrix/Synapse error). Logs
 *  server-side on every branch before responding — the client only ever gets
 *  a status code plus a fixed sentinel string; the raw upstream message
 *  (which can carry internal URLs, Synapse error codes, or other transport
 *  detail — LOW, r2-rooms-B3: this used to go out verbatim in the 502 body)
 *  stays server-side only, in the console.error call. */
export function mapRoomError(err: unknown, context: RoomErrorContext = {}): Response {
  const message = err instanceof Error ? err.message : String(err)

  if (err instanceof MatrixUnavailableError) {
    console.error('[messages] room mutation failed: Matrix unavailable', { ...context, error: message })
    return json({ success: false, error: 'MATRIX_UNAVAILABLE' }, { status: 503 })
  }
  if (err instanceof RoomConflictError) {
    console.error('[messages] room mutation failed: conflict', { ...context, error: message })
    return json({ success: false, error: 'room already exists', data: { roomId: err.roomId } }, { status: 409 })
  }
  if (err instanceof RoomNotFoundError) {
    console.error('[messages] room mutation failed: not found', { ...context, error: message })
    return json({ success: false, error: err.message }, { status: 404 })
  }
  console.error('[messages] room mutation failed: unclassified upstream error', { ...context, error: message })
  return json({ success: false, error: 'MATRIX_UPSTREAM_ERROR' }, { status: 502 })
}
