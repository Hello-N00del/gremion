// org-unit-dependents.ts -- what still hangs on an org unit, and how to say so.
//
// Deleting an org unit is refused while records exist that the database will not
// orphan: roster rows, sub-groups, elections, minutes and the resolutions under
// them. (Rows that belong to the unit itself, such as its roles, calendar colour,
// register settings and provisioning ledger, go with it by ON DELETE CASCADE.)
// The route asks BEFORE it tears anything down in Keycloak, Nextcloud or Matrix,
// so a refusal leaves everything as it was.
import { getDb } from '../db'

export interface OrgUnitDependents {
  readonly members: number
  readonly children: number
  readonly elections: number
  readonly protocols: number
  readonly resolutions: number
}

export async function getOrgUnitDependents(orgUnitId: string): Promise<OrgUnitDependents> {
  const rows = await getDb()<OrgUnitDependents[]>`
    SELECT
      (SELECT count(*) FROM org_unit_members WHERE org_unit_id = ${orgUnitId})::int AS members,
      (SELECT count(*) FROM org_units WHERE parent_id = ${orgUnitId})::int AS children,
      (SELECT count(*) FROM committee_elections WHERE org_unit_id = ${orgUnitId})::int AS elections,
      (SELECT count(*) FROM protocols WHERE committee_id = ${orgUnitId})::int AS protocols,
      (SELECT count(*) FROM protocol_resolutions r JOIN protocols p ON p.id = r.protocol_id
         WHERE p.committee_id = ${orgUnitId})::int AS resolutions`
  return rows[0] ?? { members: 0, children: 0, elections: 0, protocols: 0, resolutions: 0 }
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** The German 409 text naming what still hangs on the unit, or null when nothing does. */
export function describeOrgUnitDependents(d: OrgUnitDependents): string | null {
  const parts: string[] = []
  if (d.members > 0) parts.push(count(d.members, 'Mitglied', 'Mitglieder'))
  if (d.children > 0) parts.push(count(d.children, 'Untergruppe', 'Untergruppen'))
  if (d.elections > 0) parts.push(count(d.elections, 'Wahl', 'Wahlen'))
  if (d.protocols > 0) parts.push(count(d.protocols, 'Protokoll', 'Protokolle'))
  if (d.resolutions > 0) parts.push(count(d.resolutions, 'Beschluss', 'Beschlüsse'))
  if (parts.length === 0) return null
  return `Das Gremium kann nicht gelöscht werden, solange noch Daten daran hängen: ${parts.join(', ')}.`
}

/** The text for a foreign-key refusal that no guard anticipated. */
export const ORG_UNIT_STILL_REFERENCED =
  'Das Gremium kann nicht gelöscht werden, solange noch andere Daten daran hängen.'

/** True for a PostgreSQL foreign-key violation (23503), however the driver wrapped it. */
export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23503'
}
