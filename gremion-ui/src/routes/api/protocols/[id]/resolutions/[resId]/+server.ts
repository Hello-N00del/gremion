import { error, json } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import { updateResolution, deleteResolution } from '$lib/server/protocols/protocol-db'
import { getDb } from '$lib/server/db'
import { decideResolution } from '$lib/server/governance/resolution-decision'
import type { MajorityRule } from '$lib/server/governance/decision-rule'

function requireAdmin(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  if (!hasRole(user.roles, Role.CouncilAdmin)) throw error(403, 'Nur Admins')
  return user
}

export async function PATCH(event: RequestEvent) {
  requireAdmin(event)
  const body = await event.request.json()
  const sql = getDb()
  const [current] = await sql<{
    protocol_id: string
    votes_yes: number
    votes_no: number
    votes_abstain: number
    required_majority: MajorityRule
  }[]>`SELECT protocol_id, votes_yes, votes_no, votes_abstain, required_majority
       FROM protocol_resolutions WHERE id = ${event.params.resId!}`
  if (!current) throw error(404, 'Beschluss nicht gefunden')

  const votesYes = body.votes_yes ?? body.votesYes ?? current.votes_yes
  const votesNo = body.votes_no ?? body.votesNo ?? current.votes_no
  const votesAbstain = body.votes_abstain ?? body.votesAbstain ?? current.votes_abstain
  // INV-5: the decision rule is FIXED at creation. An edit never changes it —
  // always recompute against the rule stored on the row, ignoring any client
  // `requiredMajority` so an admin cannot retroactively pick a rule to flip the
  // outcome after tallies are entered.
  const requiredMajority: MajorityRule = current.required_majority

  // INV-5: recompute the binding result server-side from the (possibly patched)
  // tallies + the fixed rule. Quorum is enforced AT ADOPTION (publish), not on a
  // draft edit, so this path does not block a not-yet-quorate meeting.
  const decision = await decideResolution({
    protocolId: current.protocol_id,
    votesYes,
    votesNo,
    votesAbstain,
    requiredMajority,
    withdrawn: body.result === 'withdrawn',
    enforceQuorum: false,
  })

  const resolution = await updateResolution(event.params.resId!, {
    text: body.text,
    votesYes,
    votesNo,
    votesAbstain,
    result: decision.result,
    requiredMajority,
  })
  return json({ resolution })
}

export async function DELETE(event: RequestEvent) {
  requireAdmin(event)
  await deleteResolution(event.params.resId!)
  return new Response(null, { status: 204 })
}
