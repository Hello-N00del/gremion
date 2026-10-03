import { error } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { HeliosClient, deriveLifecycle, type ElectionLifecycle } from '$lib/server/elections/helios-client'
import { ElectionDb, type CommitteeElection } from '$lib/server/elections/election-db'

export interface ElectionListRow {
  uuid: string
  name: string
  description: string
  votingStartsAt: string | null
  votingEndsAt: string | null
  numCastVotes: number
  lifecycle: ElectionLifecycle
  committeeId: string
  calendarLinked: boolean
}

export const load: PageServerLoad = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) {
    error(403, 'Forbidden')
  }

  const isAdmin = hasRole(user.roles, Role.CouncilAdmin) || hasRole(user.roles, Role.ITAdmin)

  // Admins see all tracked elections; members see elections for org-units they belong to.
  // Membership (org_unit_members) is the source of truth — keycloak_group_id was dropped.
  let rows: readonly CommitteeElection[] = []
  try {
    rows = isAdmin
      ? await ElectionDb.findAll()
      : await ElectionDb.findVisibleToUser(user.id)
  } catch {
    // DB unavailable — render empty list
    rows = []
  }

  // Fetch Helios data for each tracked election in parallel; skip any that fail.
  const results = await Promise.allSettled(
    rows.map((row) => HeliosClient.getElection(row.helios_uuid)),
  )

  const elections: ElectionListRow[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.status === 'fulfilled') {
      const e = r.value
      elections.push({
        uuid: e.uuid,
        name: e.name,
        description: e.description,
        votingStartsAt: e.voting_starts_at,
        votingEndsAt: e.voting_ends_at,
        numCastVotes: e.num_cast_votes,
        lifecycle: deriveLifecycle(e),
        committeeId: rows[i].org_unit_id,
        calendarLinked: rows[i].calendar_linked,
      })
    }
  }

  return { elections, isAdmin }
}
