// Content Engine — which Keycloak groups the recipient picker offers.
//
// Keycloak holds more groups than the customer's committees: technical ones
// (the admin and login groups, service groups) sit next to them. A group is
// offered only when it belongs to an org unit: the provisioning ledger records
// the Keycloak group of every committee and every subunit as the external id of
// that unit's `keycloak` resource. The rule is membership in the ledger, never
// a list of names, so a technical group that appears later is hidden as well,
// and a committee or subunit created later shows up with no code change.

import { listOrgUnits } from '$lib/server/governance/org-units-db'
import { getResource } from '$lib/server/governance/provisioning/ledger'

export interface PickableGroup {
  id: string
  name: string
  path: string
}

/** The Keycloak group ids owned by the customer's org units (committees and subunits). */
export async function listOrgUnitGroupIds(): Promise<ReadonlySet<string>> {
  const units = await listOrgUnits()
  const rows = await Promise.all(units.map((unit) => getResource(unit.id, 'keycloak')))
  const ids = new Set<string>()
  for (const row of rows) if (row?.external_id) ids.add(row.external_id)
  return ids
}

/** Keep only the groups that belong to an org unit; order is preserved. */
export function onlyOrgUnitGroups<T extends { id: string }>(
  groups: readonly T[],
  orgUnitGroupIds: ReadonlySet<string>,
): T[] {
  return groups.filter((g) => orgUnitGroupIds.has(g.id))
}
