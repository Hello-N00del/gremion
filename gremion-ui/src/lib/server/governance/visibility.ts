// src/lib/server/governance/visibility.ts
//
// R29-F104-KTWIN (kernel twin of F1-FIX-04 / H19, S3#27, S3#28, S3#33, S3#39):
// the ONE rule for who may see what of an org unit. Before this helper,
// `org_units.visibility` ('all_members' | 'committee_only') was stored and
// defaulted but never read by any kernel governance read surface, so every
// signed-in user -- Guests included -- read every committee's drafts,
// attendance, resolutions and rosters. Ported from the product's reference
// implementation (the product repo's gremion-ui governance/visibility.ts,
// F1-FIX-04-S).
//
// Operator decision D-3 (R29-I16, binding): "NOTHING UNTIL PUBLISHED".
//   - CouncilAdmin (and ITAdmin, via the role hierarchy) sees everything.
//   - A member of the unit (org_unit_members) sees everything of that unit,
//     whatever their realm role.
//   - A Member sees all_members units in full.
//   - Anyone else signed in (a Guest) sees only PUBLISHED protocols of
//     all_members units -- the "published public items". Nothing of a
//     committee_only unit, no drafts, no rosters.
//   - No session sees nothing.
//
// Unit LISTING (names in the org tree and the committee list) is deliberately
// not decided here: whether D-3 covers the org chart is an open operator
// question, so those surfaces are left as they are.
//
// The pure predicates take the membership answer as an argument so callers can
// skip the membership query whenever the answer cannot change the outcome.
import { hasRole, Role } from '$lib/auth'
import { getOrgUnitIdsForUser, isMemberOf } from './org-units-db'

export type OrgUnitVisibility = 'all_members' | 'committee_only'
export type GovernanceStatus = 'draft' | 'submitted' | 'published'

/** The caller as the routes know it (locals.user / session.user). */
export interface Viewer {
  readonly id: string
  readonly roles: readonly Role[]
}

export interface UnitVisibilityInfo {
  readonly visibility: OrgUnitVisibility
}

/** CouncilAdmin (ITAdmin inherits through the role hierarchy) sees everything. */
export function seesAllGovernance(viewer: Viewer | null | undefined): boolean {
  return !!viewer && hasRole([...viewer.roles], Role.CouncilAdmin)
}

/** May the viewer see the unit itself: its non-published content and its
 *  roster (members, role holders, history)? */
export function canSeeOrgUnit(
  viewer: Viewer | null | undefined,
  unit: UnitVisibilityInfo,
  isUnitMember: boolean,
): boolean {
  if (!viewer) return false
  if (seesAllGovernance(viewer)) return true
  if (isUnitMember) return true
  return unit.visibility === 'all_members' && hasRole([...viewer.roles], Role.Member)
}

/** May the viewer see one protocol (or anything derived from it) of this unit
 *  in this status? Adds the Guest rule on top of canSeeOrgUnit: a published
 *  protocol of an all_members unit is public to every signed-in user. */
export function canSeeProtocol(
  viewer: Viewer | null | undefined,
  unit: UnitVisibilityInfo,
  status: GovernanceStatus,
  isUnitMember: boolean,
): boolean {
  if (!viewer) return false
  if (canSeeOrgUnit(viewer, unit, isUnitMember)) return true
  return unit.visibility === 'all_members' && status === 'published'
}

/** True when unit membership could change the answer for this viewer and row,
 *  i.e. the membership query is worth running. */
function membershipMatters(viewer: Viewer, unit: UnitVisibilityInfo, status: GovernanceStatus): boolean {
  return !canSeeProtocol(viewer, unit, status, false)
}

/** Can the viewer see this protocol? Runs at most one membership query, and
 *  none when membership cannot change the answer. */
export async function viewerCanSeeProtocol(
  viewer: Viewer | null | undefined,
  unitId: string,
  unit: UnitVisibilityInfo,
  status: GovernanceStatus,
): Promise<boolean> {
  if (!viewer) return false
  if (!membershipMatters(viewer, unit, status)) return true
  return canSeeProtocol(viewer, unit, status, await isMemberOf(unitId, viewer.id))
}

export interface VisibleProtocolRow {
  readonly committeeId: string
  readonly visibility: OrgUnitVisibility
  readonly status: GovernanceStatus
}

/** Filters a cross-committee protocol list down to what the viewer may see.
 *  At most one membership query, and none for an admin or when no row needs it. */
export async function filterVisibleProtocols<T extends VisibleProtocolRow>(
  viewer: Viewer | null | undefined,
  rows: readonly T[],
): Promise<T[]> {
  if (!viewer) return []
  if (seesAllGovernance(viewer)) return [...rows]
  const needsMembership = rows.some((r) => membershipMatters(viewer, r, r.status))
  const memberOf: ReadonlySet<string> = needsMembership
    ? new Set(await getOrgUnitIdsForUser(viewer.id))
    : new Set()
  return rows.filter((r) => canSeeProtocol(viewer, r, r.status, memberOf.has(r.committeeId)))
}

/** The fail-closed fallback when the membership lookup failed: keep only the
 *  rows the viewer may see without being a unit member. */
export function visibleProtocolsWithoutMembership<T extends VisibleProtocolRow>(
  viewer: Viewer | null | undefined,
  rows: readonly T[],
): T[] {
  return rows.filter((r) => canSeeProtocol(viewer, r, r.status, false))
}

export interface VisiblePublishedRow {
  readonly committeeId: string
  readonly visibility: OrgUnitVisibility
}

/** Filters rows that all derive from PUBLISHED protocols (the Beschlussbuch:
 *  passed resolutions of published protocols) down to what the viewer may see.
 *  Same rule and the same single membership query as filterVisibleProtocols. */
export async function filterVisiblePublished<T extends VisiblePublishedRow>(
  viewer: Viewer | null | undefined,
  rows: readonly T[],
): Promise<T[]> {
  const tagged = rows.map((row) => ({
    row,
    committeeId: row.committeeId,
    visibility: row.visibility,
    status: 'published' as const,
  }))
  return (await filterVisibleProtocols(viewer, tagged)).map((t) => t.row)
}

/** The fail-closed fallback for published rows when the membership lookup
 *  failed: keep only the rows the viewer may see without being a unit member. */
export function visiblePublishedWithoutMembership<T extends VisiblePublishedRow>(
  viewer: Viewer | null | undefined,
  rows: readonly T[],
): T[] {
  return rows.filter((r) => canSeeProtocol(viewer, r, 'published', false))
}
