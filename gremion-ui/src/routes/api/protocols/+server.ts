import { error, json } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import { createProtocol, listProtocols, updateProtocol, deleteProtocol } from '$lib/server/protocols/protocol-db'
import { getProtocolDocumentPort } from '$lib/server/modules/runtime-registry'
import type { ProtocolDocumentPort } from '$lib/server/modules/runtime-registry'

function requireAuth(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  return user
}

// A3a-2: the Nextcloud draft document ops come from the files module's
// ProtocolDocumentPort. When the files module is absent the draft subsystem is
// unavailable — fail fast with a 'service unavailable' status (503) instead of
// dereferencing an undefined port.
function requireDocumentPort(): ProtocolDocumentPort {
  const port = getProtocolDocumentPort()
  if (!port) throw error(503, 'Dokumentdienst nicht verfügbar')
  return port
}

export async function GET(event: RequestEvent) {
  try {
    requireAuth(event)
    const committeeId = event.url.searchParams.get('committeeId')
    if (!committeeId) throw error(400, 'committeeId required')
    const status = event.url.searchParams.get('status') as 'draft' | 'submitted' | 'published' | undefined
    const yearParam = event.url.searchParams.get('year')
    const year = yearParam ? parseInt(yearParam, 10) : undefined
    const protocols = await listProtocols({ committeeId, status: status ?? undefined, year })
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

    // Resolve the document port BEFORE inserting the row so an unavailable
    // documents subsystem fails fast (503) without leaving an orphan protocol.
    const docs = requireDocumentPort()

    const protocol = await createProtocol({ committeeId, meetingDate, title, location, createdBy: user.id })
    let draftPath: string | null = null
    try {
      draftPath = await docs.createDraftFile(protocol.id)
      const updated = await updateProtocol(protocol.id, { nextcloudDraftPath: draftPath })
      return json({ protocol: updated }, { status: 201 })
    } catch (draftErr) {
      // Compensating cleanup (#185): the row was inserted before the Nextcloud
      // draft document existed. Without the draft the protocol can never be
      // opened ("Kein Entwurfsdokument vorhanden"), so delete the orphan row.
      console.error('[api/protocols] draft creation failed, deleting orphan row:', draftErr)
      await deleteProtocol(protocol.id).catch((delErr) =>
        console.error('[api/protocols] orphan row cleanup failed:', delErr))
      // #208: if createDraftFile SUCCEEDED but updateProtocol then failed, the
      // draft ODT exists on Nextcloud while its row is now gone — an orphaned
      // file. Best-effort delete it (deleteDraftFile already swallows errors).
      if (draftPath) await docs.deleteDraftFile(draftPath)
      throw error(502, 'Entwurfsdokument konnte nicht erstellt werden. Bitte erneut versuchen.')
    }
  } catch (e) {
    const err = e as { status?: number; body?: { message?: string } }
    if (err?.status) return json({ error: err.body?.message ?? 'Error' }, { status: err.status })
    throw e
  }
}
