// T2 (#320 contestability): POST /api/protocols/resolutions/[resId]/challenges
// — a MEMBER files a formal challenge against a resolution. Filing is a member
// act: any session holding Role.Member (or above) may POST (no CouncilAdmin
// required; a guest is refused, TASK-206-A review); the challenger identity
// always comes from the session, never the body.
//
// Deliberately under api/protocols/ (NOT a KERNEL_PREFIXES path,
// route-coverage.ts:8), so the kernel OpenAPI equivalence gate
// (contracts-real-specs.test.ts) is untouched.
import { error, json } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { hasRole, Role, type SessionUser } from '$lib/auth'
import { getResolutionById, getProtocol } from '$lib/server/protocols/protocol-db'
import { getOrgUnit } from '$lib/server/governance/org-units-db'
import { seesAllGovernance, viewerCanSeeProtocol } from '$lib/server/governance/visibility'
import { requireUuidParams } from '$lib/server/protocols/route-ids'
import {
  fileChallenge,
  DuplicateOpenChallengeError,
  ResolutionNotFoundError,
  ResolutionNotAdoptedError,
} from '$lib/server/governance/resolution-challenges-db'

function requireUser(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  return user
}

function requireMember(event: RequestEvent): SessionUser {
  const user = requireUser(event)
  if (!hasRole(user.roles ?? [], Role.Member)) throw error(403, 'Forbidden')
  return user
}

export async function POST(event: RequestEvent) {
  const user = requireMember(event)
  requireUuidParams(event, 'resId')
  const body = await event.request.json()

  const grounds = typeof body?.grounds === 'string' ? body.grounds.trim() : ''
  if (grounds.length === 0) {
    throw error(400, 'Begründung (grounds) erforderlich')
  }
  // Mirror of the DB bound (055: char_length(grounds) BETWEEN 1 AND 4000) so an
  // oversize submission gets a clean 400 instead of a CHECK-violation 500.
  if (grounds.length > 4000) {
    throw error(400, 'Begründung zu lang (max. 4000 Zeichen)')
  }

  // LOW-6: the filer must be able to SEE the resolution's protocol (committee
  // visibility). An invisible resolution answers the same 404 as a missing one,
  // so the endpoint is no existence oracle.
  if (!seesAllGovernance(user)) {
    const resolution = await getResolutionById(event.params.resId!)
    const protocol = resolution ? await getProtocol(resolution.protocol_id) : null
    const unit = protocol ? await getOrgUnit(protocol.committee_id) : null
    if (!protocol || !unit || !(await viewerCanSeeProtocol(user, protocol.committee_id, unit, protocol.status))) {
      throw error(404, 'Beschluss nicht gefunden')
    }
  }

  try {
    const challenge = await fileChallenge({
      resolutionId: event.params.resId!,
      raisedBy: user.id,
      grounds,
    })
    return json({ challenge }, { status: 201 })
  } catch (err) {
    if (err instanceof DuplicateOpenChallengeError) {
      throw error(409, 'Es existiert bereits ein offener Einspruch von dir zu diesem Beschluss')
    }
    if (err instanceof ResolutionNotFoundError) {
      throw error(404, 'Beschluss nicht gefunden')
    }
    if (err instanceof ResolutionNotAdoptedError) {
      throw error(403, 'Nur angenommene Beschlüsse können angefochten werden')
    }
    throw err
  }
}
