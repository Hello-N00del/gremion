// src/lib/server/board/scope.ts
//
// WI-6 board visibility resolver. Mirrors the WI-2 finance scope rule
// (resolveFinanceOrgUnitScope / isAuditor): an auditor (it-admin) sees ALL
// boards; everyone else is limited to the org-units they belong to. Pure +
// dependency-injected so the unit test drives it without a DB.
import { getOrgUnitIdsForUser, listOrgUnits } from '$lib/server/governance/org-units-db'

export interface BoardActor {
  userId: string
  roles: readonly string[]
}

const defaultDeps = {
  allOrgUnitIds: async (): Promise<readonly string[]> => (await listOrgUnits()).map((o) => o.id),
  myOrgUnitIds: (userId: string): Promise<readonly string[]> => getOrgUnitIdsForUser(userId),
}

export async function resolveBoardOrgUnitScope(
  actor: BoardActor,
  deps: {
    allOrgUnitIds: () => Promise<readonly string[]>
    myOrgUnitIds: (userId: string) => Promise<readonly string[]>
  } = defaultDeps,
): Promise<readonly string[]> {
  if (actor.roles.includes('it-admin')) return deps.allOrgUnitIds()
  return deps.myOrgUnitIds(actor.userId)
}
