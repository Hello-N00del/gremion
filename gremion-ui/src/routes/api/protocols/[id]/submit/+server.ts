import { error, json } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import { getProtocol, setProtocolStatus, listResolutions } from '$lib/server/protocols/protocol-db'
import { untalliedResolutionsMessage } from '$lib/governance/resolution-vote-state'
import { requireUuidParams } from '$lib/server/protocols/route-ids'

function requireAuth(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  return user
}

export async function POST(event: RequestEvent) {
  try {
    const user = requireAuth(event)
    if (!hasRole(user.roles, Role.CouncilAdmin)) throw error(403, 'Nur Admins können einreichen')
    requireUuidParams(event, 'id')

    const protocol = await getProtocol(event.params.id!)
    if (!protocol) throw error(404, 'Protokoll nicht gefunden')
    if (protocol.status !== 'draft') throw error(400, 'Nur Entwürfe können eingereicht werden')

    // Every counted resolution needs its vote BEFORE the protocol leaves draft:
    // the page edits resolutions in draft only, and publish (= adoption) refuses a
    // resolution nobody voted on. A fresh row is 0/0/0 with the rule engine's
    // placeholder "rejected"; submitting it would freeze a decision that was never
    // taken. The admin enters the count, withdraws the resolution or deletes it.
    const untallied = untalliedResolutionsMessage(await listResolutions(protocol.id))
    if (untallied) throw error(422, untallied)

    // (open-core carve) Submission previously created a Nextcloud Polls approval
    // vote and stored its id on the protocol. Nextcloud Polls is a feature
    // module, not part of the governance kernel; approval is gated natively at
    // publish via the INV-5 quorum context. Beyond the vote check above, submit
    // flips the status.
    const updated = await setProtocolStatus(protocol.id, 'submitted')
    return json({ protocol: updated })
  } catch (e) {
    const err = e as { status?: number; body?: { message?: string } }
    if (err?.status) return json({ error: err.body?.message ?? 'Error' }, { status: err.status })
    throw e
  }
}
