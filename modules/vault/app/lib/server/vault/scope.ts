// src/lib/server/vault/scope.ts
//
// Vault visibility resolver. Mirrors the board scope rule
// (resolveBoardOrgUnitScope): an it-admin sees ALL vault items; everyone else is
// limited to the org-units they belong to. Pure + dependency-injected so the
// unit test drives it without a DB.
import { getOrgUnitIdsForUser, listOrgUnits } from '$lib/server/governance/org-units-db'

export interface VaultActor {
  userId: string
  roles: readonly string[]
}

const defaultDeps = {
  allOrgUnitIds: async (): Promise<readonly string[]> => (await listOrgUnits()).map((o) => o.id),
  myOrgUnitIds: (userId: string): Promise<readonly string[]> => getOrgUnitIdsForUser(userId),
}

export async function resolveVaultOrgUnitScope(
  actor: VaultActor,
  deps: {
    allOrgUnitIds: () => Promise<readonly string[]>
    myOrgUnitIds: (userId: string) => Promise<readonly string[]>
  } = defaultDeps,
): Promise<readonly string[]> {
  if (actor.roles.includes('it-admin')) return deps.allOrgUnitIds()
  return deps.myOrgUnitIds(actor.userId)
}
