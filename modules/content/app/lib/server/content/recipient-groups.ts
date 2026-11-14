// Content Engine — which Keycloak groups may receive a post by email.
//
// Only the groups of the customer's org units: the picker offers no other
// group, saving a recipient set accepts no other group, and the send resolves
// no other group. Which groups those are is the kernel's knowledge
// (governance/org-unit-groups); this module is the content side of the rule.

import { listOrgUnitGroupIds } from '$lib/server/governance/org-unit-groups'

export { listOrgUnitGroupIds }

export interface PickableGroup {
  id: string
  name: string
  path: string
}

/** Keep only the groups that belong to an org unit; order is preserved. */
export function onlyOrgUnitGroups<T extends { id: string }>(
  groups: readonly T[],
  orgUnitGroupIds: ReadonlySet<string>,
): T[] {
  return groups.filter((g) => orgUnitGroupIds.has(g.id))
}
