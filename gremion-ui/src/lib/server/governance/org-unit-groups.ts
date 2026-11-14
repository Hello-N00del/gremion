// Which Keycloak groups belong to the customer's org units.
//
// Keycloak holds more groups than the customer's committees: technical ones
// (the admin and login groups, service groups) sit next to them. The
// provisioning ledger records the Keycloak group of every committee and every
// subunit as the external id of that unit's `keycloak` resource. Membership in
// the ledger is the rule, never a list of names: a technical group that appears
// later is not an org-unit group, and a committee or subunit created later is
// one with no code change.

import { listOrgUnits } from './org-units-db'
import { getResource } from './provisioning/ledger'

/** The Keycloak group ids owned by the customer's org units (committees and subunits). */
export async function listOrgUnitGroupIds(): Promise<ReadonlySet<string>> {
  const units = await listOrgUnits()
  const rows = await Promise.all(units.map((unit) => getResource(unit.id, 'keycloak')))
  const ids = new Set<string>()
  for (const row of rows) if (row?.external_id) ids.add(row.external_id)
  return ids
}
