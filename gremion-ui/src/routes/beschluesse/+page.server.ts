import type { PageServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import {
  listBeschluesse,
  listChallengesForBeschluesse,
  type BeschlussChallengeRow,
} from '$lib/server/governance/protocols-db'

// The Beschlussbuch aggregates passed resolutions from published protocols
// (see protocols-db.listBeschluesse). DB unavailability degrades to an empty
// list → the page renders its first-class empty state.
//
// T6 (#320 contestability): rows now carry openChallengeCount for the
// 'Einspruch offen' badge. The per-challenge disposition data is loaded ONLY
// for CouncilAdmin sessions (same gate the surrounding pages use, e.g.
// votes/+page.server.ts:129) — non-admins never receive challenger identities.
function summarize(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const code = (err as { code?: unknown }).code
  const suffix = typeof code === 'string' || typeof code === 'number' ? ` (code ${code})` : ''
  return `${err.name}: ${err.message}${suffix}`
}

export const load: PageServerLoad = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  const isAdmin = !!user && hasRole(user.roles, Role.CouncilAdmin)

  // #439: both loads degrade to an empty list so the page still renders, but a
  // silent `.catch(() => [])` made a genuine query fault indistinguishable from
  // "nothing to show" — an admin with challenges awaiting disposition would be
  // told there are none. Log a summary (never the raw error: postgres.js
  // carries query + parameters on it, #458-2) before degrading. Each degraded
  // load also sets an `…Unavailable` flag so the page can say "could not be
  // loaded" instead of rendering the empty state as if there were nothing
  // (R28 review: a log line alone never reaches the admin looking at the page).
  let beschluesseUnavailable = false
  const beschluesse = await listBeschluesse().catch((err) => {
    console.error('[beschluesse] listBeschluesse failed, degrading to empty:', summarize(err))
    beschluesseUnavailable = true
    return []
  })
  let challengesUnavailable = false
  const challenges: readonly BeschlussChallengeRow[] = isAdmin
    ? await listChallengesForBeschluesse().catch((err) => {
        console.error('[beschluesse] listChallengesForBeschluesse failed, degrading to empty:', summarize(err))
        challengesUnavailable = true
        return []
      })
    : []

  return { beschluesse, isAdmin, challenges, beschluesseUnavailable, challengesUnavailable }
}
