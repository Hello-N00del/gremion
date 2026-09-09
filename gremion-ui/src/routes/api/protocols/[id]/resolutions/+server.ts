import { error, json } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import { getProtocol, addResolution } from '$lib/server/protocols/protocol-db'
import { decideResolution } from '$lib/server/governance/resolution-decision'
import { DEFAULT_MAJORITY, type MajorityRule } from '$lib/server/governance/decision-rule'

function requireAdmin(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  if (!hasRole(user.roles, Role.CouncilAdmin)) throw error(403, 'Nur Admins')
  return user
}

export async function POST(event: RequestEvent) {
  requireAdmin(event)
  const protocol = await getProtocol(event.params.id!)
  if (!protocol || protocol.status === 'published') throw error(403, 'Nicht bearbeitbar')
  const body = await event.request.json()
  const votesYes = body.votesYes ?? 0
  const votesNo = body.votesNo ?? 0
  const votesAbstain = body.votesAbstain ?? 0
  const requiredMajority: MajorityRule = body.requiredMajority ?? DEFAULT_MAJORITY

  // INV-5: the binding result is computed server-side from the pre-declared rule
  // + tallies — never accepted free-hand from the client. Quorum is enforced AT
  // ADOPTION (protocol publish), not during draft data-entry, so this write path
  // does not block a not-yet-quorate meeting (enforceQuorum: false).
  const decision = await decideResolution({
    protocolId: protocol.id,
    votesYes,
    votesNo,
    votesAbstain,
    requiredMajority,
    withdrawn: body.result === 'withdrawn',
    enforceQuorum: false,
  })

  const resolution = await addResolution(protocol.id, {
    text: body.text ?? '',
    votesYes,
    votesNo,
    votesAbstain,
    result: decision.result,
    requiredMajority,
  })
  return json({ resolution }, { status: 201 })
}
