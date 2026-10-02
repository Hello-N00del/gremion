// T2 (#320 contestability): PATCH
// /api/protocols/resolutions/[resId]/challenges/[challengeId] — ADMIN
// disposition of an open challenge ('upheld' | 'dismissed', optional decision
// note). Disposition never modifies protocol_resolutions.result — the service
// records the outcome plus its same-tx INV-1 audit entry, nothing more.
import { error, json } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import {
  decideChallenge,
  ChallengeNotOpenError,
  type ChallengeDisposition,
} from '$lib/server/governance/resolution-challenges-db'

// Sibling convention: api/protocols/[id]/resolutions/[resId]/+server.ts:10-15.
function requireAdmin(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  if (!hasRole(user.roles, Role.CouncilAdmin)) throw error(403, 'Nur Admins')
  return user
}

export async function PATCH(event: RequestEvent) {
  const admin = requireAdmin(event)
  const body = await event.request.json()

  const status = body?.status as ChallengeDisposition
  if (status !== 'upheld' && status !== 'dismissed') {
    throw error(400, "Ungültige Entscheidung (erlaubt: 'upheld' | 'dismissed')")
  }
  const decisionNoteRaw = body?.decision_note ?? body?.decisionNote ?? null
  if (decisionNoteRaw !== null && typeof decisionNoteRaw !== 'string') {
    throw error(400, 'decision_note muss ein Text sein')
  }
  // Empty string ≙ no note; mirror the DB bound (055: 1–4000 chars or NULL).
  const decisionNote = decisionNoteRaw === null || decisionNoteRaw.trim().length === 0
    ? null
    : decisionNoteRaw.trim()
  if (decisionNote !== null && decisionNote.length > 4000) {
    throw error(400, 'decision_note zu lang (max. 4000 Zeichen)')
  }

  try {
    const challenge = await decideChallenge({
      challengeId: event.params.challengeId!,
      resolutionId: event.params.resId!,
      resolvedBy: admin.id,
      status,
      decisionNote,
    })
    return json({ challenge })
  } catch (err) {
    if (err instanceof ChallengeNotOpenError) {
      throw error(404, 'Einspruch nicht gefunden oder bereits entschieden')
    }
    throw err
  }
}
