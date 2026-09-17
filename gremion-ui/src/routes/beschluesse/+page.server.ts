import type { PageServerLoad } from './$types'
import { listBeschluesse, listChallengesForBeschluesse } from '$lib/server/governance/protocols-db'

// The Beschlussbuch aggregates passed resolutions from published protocols
// (see protocols-db.listBeschluesse). DB unavailability degrades to an empty
// list → the page renders its first-class empty state.
export const load: PageServerLoad = async () => {
  const [beschluesse, challenges] = await Promise.all([
    listBeschluesse().catch(() => []),
    listChallengesForBeschluesse().catch(() => []),
  ])
  return { beschluesse, challenges }
}
