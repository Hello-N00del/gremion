import { error, json } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import { getProtocol, setProtocolStatus } from '$lib/server/protocols/protocol-db'

function requireAuth(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  return user
}

export async function POST(event: RequestEvent) {
  try {
    const user = requireAuth(event)
    if (!hasRole(user.roles, Role.CouncilAdmin)) throw error(403, 'Nur Admins können einreichen')

    const protocol = await getProtocol(event.params.id!)
    if (!protocol) throw error(404, 'Protokoll nicht gefunden')
    if (protocol.status !== 'draft') throw error(400, 'Nur Entwürfe können eingereicht werden')

    // (open-core carve) Submission previously created a Nextcloud Polls approval
    // vote and stored its id on the protocol. Nextcloud Polls is a feature
    // module, not part of the governance kernel; approval is gated natively at
    // publish via the INV-5 quorum context. Submit now just flips the status.
    const updated = await setProtocolStatus(protocol.id, 'submitted')
    return json({ protocol: updated })
  } catch (e) {
    const err = e as { status?: number; body?: { message?: string } }
    if (err?.status) return json({ error: err.body?.message ?? 'Error' }, { status: err.status })
    throw e
  }
}
