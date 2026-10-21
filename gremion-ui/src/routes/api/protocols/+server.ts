import { error, json } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import { createProtocol, listProtocols, updateProtocol, deleteProtocol } from '$lib/server/protocols/protocol-db'
import { getProtocolDocumentPort } from '$lib/server/modules/runtime-registry'
import { getOrgUnit, isMemberOf } from '$lib/server/governance/org-units-db'
import { canSeeProtocol, seesAllGovernance } from '$lib/server/governance/visibility'

function requireAuth(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  return user
}

// R29-F104-KTWIN (kernel twin of F1-FIX-04 / H19, operator decision D-3): the
// list is filtered through the ONE visibility rule (governance/visibility.ts).
// A Guest gets only the published protocols of an all_members unit, nothing of
// a committee_only unit; a unit member and a CouncilAdmin get every status. An
// unknown unit, and a unit the caller may see nothing of, is a 404.
export async function GET(event: RequestEvent) {
  try {
    const user = requireAuth(event)
    const committeeId = event.url.searchParams.get('committeeId')
    if (!committeeId) throw error(400, 'committeeId required')
    const status = event.url.searchParams.get('status') as 'draft' | 'submitted' | 'published' | undefined
    const yearParam = event.url.searchParams.get('year')
    const year = yearParam ? parseInt(yearParam, 10) : undefined
    // The unknown-unit 404 comes first, so every role gets the same contract.
    const unit = await getOrgUnit(committeeId)
    if (!unit) throw error(404, 'Gremium nicht gefunden')
    const rows = await listProtocols({ committeeId, status: status ?? undefined, year })
    if (seesAllGovernance(user)) return json({ protocols: rows })

    // One membership query at most, and only when it can change the outcome.
    const memberMatters =
      unit.visibility === 'committee_only' || rows.some((p) => !canSeeProtocol(user, unit, p.status, false))
    const isUnitMember = memberMatters ? await isMemberOf(committeeId, user.id) : false
    // A unit the caller may see nothing of (a foreign committee_only unit) is a
    // 404, exactly like a missing one, so its existence does not leak.
    if (!canSeeProtocol(user, unit, 'published', isUnitMember)) throw error(404, 'Gremium nicht gefunden')
    const protocols = rows.filter((p) => canSeeProtocol(user, unit, p.status, isUnitMember))
    return json({ protocols })
  } catch (e) {
    const err = e as { status?: number; body?: { message?: string } }
    if (err?.status) return json({ error: err.body?.message ?? 'Error' }, { status: err.status })
    throw e
  }
}

export async function POST(event: RequestEvent) {
  try {
    const user = requireAuth(event)
    if (!hasRole(user.roles, Role.CouncilAdmin)) throw error(403, 'Nur Admins können Protokolle erstellen')
    const body = await event.request.json()
    const { committeeId, meetingDate, title, location } = body
    if (!committeeId || !meetingDate || !title) throw error(400, 'committeeId, meetingDate and title required')

    // F1 (operator ruling Q1, 2026-10-21): the protocol body lives in-app
    // (protocols.body_html), so create never needs the files module. The
    // Nextcloud draft ODT is an optional extra: with the document port present
    // it is created as before; if the port is absent, or Nextcloud is down, the
    // protocol is created without a draft (in-app only).
    const docs = getProtocolDocumentPort()
    const protocol = await createProtocol({ committeeId, meetingDate, title, location, createdBy: user.id })
    if (!docs) return json({ protocol }, { status: 201 })
    let draftPath: string | null = null
    try {
      draftPath = await docs.createDraftFile(protocol.id)
    } catch (draftErr) {
      console.error('[api/protocols] draft creation failed, keeping the protocol as in-app only:', draftErr)
      return json({ protocol }, { status: 201 })
    }
    try {
      const updated = await updateProtocol(protocol.id, { nextcloudDraftPath: draftPath })
      return json({ protocol: updated }, { status: 201 })
    } catch (dbErr) {
      // #185/#208: the draft ODT exists but the row update failed (DB trouble):
      // remove the orphan row and best-effort delete the orphaned draft file.
      console.error('[api/protocols] draft path persist failed, deleting orphan row:', dbErr)
      await deleteProtocol(protocol.id).catch((delErr) =>
        console.error('[api/protocols] orphan row cleanup failed:', delErr))
      await docs.deleteDraftFile(draftPath)
      throw error(502, 'Entwurfsdokument konnte nicht erstellt werden. Bitte erneut versuchen.')
    }
  } catch (e) {
    const err = e as { status?: number; body?: { message?: string } }
    if (err?.status) return json({ error: err.body?.message ?? 'Error' }, { status: err.status })
    throw e
  }
}
