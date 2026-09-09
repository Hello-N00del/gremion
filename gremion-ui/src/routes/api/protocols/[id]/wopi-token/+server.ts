import { error, json } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import { getProtocol } from '$lib/server/protocols/protocol-db'
import { getProtocolDocumentPort } from '$lib/server/modules/runtime-registry'

function requireAuth(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  return user
}

export async function GET(event: RequestEvent) {
  const user = requireAuth(event)
  const protocol = await getProtocol(event.params.id!)
  if (!protocol) throw error(404, 'Protokoll nicht gefunden')
  if (protocol.status !== 'draft') throw error(403, 'Nur Entwürfe können bearbeitet werden')

  const isGuest = user.roles.length === 1 && user.roles[0] === Role.Guest
  if (isGuest && !protocol.guest_edit_enabled) throw error(403, 'Gastzugang nicht aktiviert')
  if (!hasRole(user.roles, Role.Member) && !protocol.guest_edit_enabled) throw error(403, 'Zugriff verweigert')

  if (!protocol.nextcloud_draft_path) throw error(400, 'Kein Entwurfsdokument vorhanden')
  // A3a-2: the WOPI editor URL is minted by the files module's document port.
  const docs = getProtocolDocumentPort()
  if (!docs) throw error(503, 'Dokumentdienst nicht verfügbar')
  const tokenInfo = await docs.getDraftWopiToken(protocol.nextcloud_draft_path)
  return json(tokenInfo)
}
