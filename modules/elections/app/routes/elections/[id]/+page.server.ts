import { error } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import {
  HeliosClient,
  deriveLifecycle,
  type HeliosElection,
  type HeliosElectionFull,
  type HeliosResult,
  type HeliosVoter,
} from '$lib/server/elections/helios-client'
import { ElectionDb } from '$lib/server/elections/election-db'
import { isMemberOf } from '$lib/server/governance/org-units-db'

export interface ElectionDetail {
  uuid: string
  name: string
  shortName: string
  description: string
  votingStartsAt: string | null
  votingEndsAt: string | null
  frozenAt: string | null
  numCastVotes: number
  lifecycle: 'draft' | 'open' | 'closed'
  committeeId: string
  calendarLinked: boolean
}

export const load: PageServerLoad = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) {
    error(403, 'Forbidden')
  }

  const uuid = params.id
  if (!uuid || uuid.length < 4) {
    error(400, 'Ungültige Wahl-ID')
  }

  // Must be tracked in committee_elections (otherwise not exposed via this UI)
  const row = await ElectionDb.findByHeliosUuid(uuid)
  if (!row) error(404, 'Wahl nicht gefunden')

  const isAdmin = hasRole(user.roles, Role.CouncilAdmin) || hasRole(user.roles, Role.ITAdmin)
  let isMember = false
  if (!isAdmin) {
    isMember = await isMemberOf(row.org_unit_id, user.id)
  }
  if (!isAdmin && !isMember) {
    error(403, 'Kein Zugriff auf diese Wahl')
  }

  let election: HeliosElection
  try {
    election = await HeliosClient.getElection(uuid)
  } catch {
    error(502, 'Helios nicht erreichbar')
  }

  const lifecycle = deriveLifecycle(election)

  // Voter ledger — admin only, skipped if Helios fails or session not configured
  let voters: readonly HeliosVoter[] = []
  if (isAdmin) {
    try {
      voters = await HeliosClient.listVoters(uuid)
    } catch {
      voters = []
    }
  }

  // Tally — only available when the election has a result (post-freeze & tally)
  let result: HeliosResult | null = null
  if (lifecycle === 'closed') {
    try {
      result = await HeliosClient.getResult(uuid)
    } catch {
      result = null
    }
  }

  let questions: HeliosElectionFull['questions'] = []
  let publicKey: unknown = null
  if (lifecycle === 'open') {
    try {
      const full = await HeliosClient.getElectionFull(uuid)
      questions = full.questions ?? []
      publicKey = full.public_key ?? null
    } catch {
      // non-fatal — ballot falls back to Helios direct link
    }
  }

  const detail: ElectionDetail = {
    uuid: election.uuid,
    name: election.name,
    shortName: election.short_name,
    description: election.description,
    votingStartsAt: election.voting_starts_at,
    votingEndsAt: election.voting_ends_at,
    frozenAt: election.frozen_at,
    numCastVotes: election.num_cast_votes,
    lifecycle,
    committeeId: row.org_unit_id,
    calendarLinked: row.calendar_linked,
  }

  return { election: detail, voters, result, isAdmin, questions, publicKey }
}
