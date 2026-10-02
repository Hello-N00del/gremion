import { error, redirect } from '@sveltejs/kit'
import type { Actions, PageServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import {
  HeliosClient,
  deriveLifecycle,
  type HeliosElection,
  type HeliosVoter,
} from '$lib/server/elections/helios-client'
import { ElectionDb } from '$lib/server/elections/election-db'

export const load: PageServerLoad = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || (!hasRole(user.roles, Role.CouncilAdmin) && !hasRole(user.roles, Role.ITAdmin))) {
    error(403, 'Nur Council-Admins dürfen Wahlen verwalten.')
  }

  const uuid = params.id
  const row = await ElectionDb.findByHeliosUuid(uuid)
  if (!row) error(404, 'Wahl nicht gefunden')

  let election: HeliosElection
  try {
    election = await HeliosClient.getElection(uuid)
  } catch {
    error(502, 'Helios nicht erreichbar')
  }

  const lifecycle = deriveLifecycle(election)
  if (lifecycle !== 'draft') {
    redirect(302, `/elections/${uuid}`)
  }

  let voters: readonly HeliosVoter[] = []
  try {
    voters = await HeliosClient.listVoters(uuid)
  } catch {
    voters = []
  }

  return {
    election: {
      uuid: election.uuid,
      name: election.name,
      shortName: election.short_name,
      description: election.description,
      votingStartsAt: election.voting_starts_at,
      votingEndsAt: election.voting_ends_at,
    },
    voters,
    committeeId: row.org_unit_id,
  }
}

export const actions: Actions = {
  freeze: async ({ params, locals }) => {
    const session = await locals.auth()
    const user = session?.user as SessionUser | undefined
    if (!user || (!hasRole(user.roles, Role.CouncilAdmin) && !hasRole(user.roles, Role.ITAdmin))) {
      error(403, 'Forbidden')
    }

    const uuid = params.id
    try {
      await HeliosClient.freeze(uuid)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('409')) {
        return { success: false, error: 'Wahl wurde bereits geöffnet.' }
      }
      return { success: false, error: 'Einfrieren fehlgeschlagen. Helios nicht erreichbar.' }
    }

    redirect(302, `/elections/${uuid}`)
  },
}
