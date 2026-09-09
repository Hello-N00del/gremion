import { error, json } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import {
  getProtocol, updateProtocol, upsertAttendance,
  listAttendance, listResolutions, listActionItems,
} from '$lib/server/protocols/protocol-db'

function requireAuth(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  return user
}

export async function GET(event: RequestEvent) {
  requireAuth(event)
  const protocol = await getProtocol(event.params.id!)
  if (!protocol) throw error(404, 'Protokoll nicht gefunden')

  const [attendance, resolutions, actionItems] = await Promise.all([
    listAttendance(protocol.id),
    listResolutions(protocol.id),
    listActionItems(protocol.id),
  ])

  const { nextcloud_draft_path: _omit, ...safeProtocol } = protocol

  return json({ protocol: safeProtocol, attendance, resolutions, actionItems })
}

export async function PATCH(event: RequestEvent) {
  const user = requireAuth(event)
  if (!hasRole(user.roles, Role.CouncilAdmin)) throw error(403, 'Nur Admins können Protokolle bearbeiten')

  const protocol = await getProtocol(event.params.id!)
  if (!protocol) throw error(404, 'Protokoll nicht gefunden')
  if (protocol.status === 'published') throw error(403, 'Veröffentlichte Protokolle können nicht bearbeitet werden')

  const body = await event.request.json()

  // Attendance capture (INV-5 quorum input): AttendanceChips PATCHes a single
  // roster cycle as { attendanceUpdate: { userId, status } }. This was silently
  // ignored before — the upsert below is what makes the attendance roster (and
  // therefore the quorum count) editable at all. Handled as its own branch so a
  // status cycle never falls through into the protocol-field COALESCE update.
  if (body.attendanceUpdate) {
    // INV-5 integrity: attendance is the quorum input, so it may only change
    // while the protocol is a draft. Once submitted (out for the approval vote)
    // or published, the roster is frozen — otherwise an admin could silently
    // shift the quorum count of a protocol that is mid-vote.
    if (protocol.status !== 'draft')
      throw error(403, 'Anwesenheit kann nur im Entwurf bearbeitet werden')
    const { userId, status } = body.attendanceUpdate
    const attendance = await upsertAttendance(protocol.id, userId, status)
    return json({ attendance })
  }

  const updated = await updateProtocol(protocol.id, {
    location: body.location,
    title: body.title,
    guestEditEnabled: body.guestEditEnabled,
  })
  return json({ protocol: updated })
}
