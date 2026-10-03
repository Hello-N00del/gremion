// gremion-ui/src/lib/server/calendar/event-authz.ts
// F1-FIX-08 (S3#29): who may change a calendar event.
//
// Before this, PATCH/DELETE /api/calendar/events/[id] only checked Role.Member,
// so any Member could edit or delete any committee's event and flip isPublic,
// publishing an internal meeting to the public portal.
//
// Rules (CouncilAdmin includes ITAdmin through the role hierarchy):
// - manage (edit/delete): CouncilAdmin, the event's creator, or a member of
//   one of the event's committees.
// - publish (isPublic=true): CouncilAdmin, or a member of one of the event's
//   (resulting) committees. Being the creator alone is not enough: the public
//   portal speaks for a committee.
// - tag a committee: CouncilAdmin, or a member of that committee. Committees
//   already on the event may stay.
// Calendar committee ids are org_unit ids (migration 010 renamed committees).

import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { getOrgUnitIdsForUser } from '$lib/server/governance/org-units-db'

export interface EventAuthzContext {
  readonly isCouncilAdmin: boolean
  readonly userId: string
  readonly memberUnitIds: ReadonlySet<string>
}

export async function loadEventAuthzContext(user: SessionUser): Promise<EventAuthzContext> {
  const isCouncilAdmin = hasRole(user.roles, Role.CouncilAdmin)
  // An admin's memberships never change the outcome; skip the query.
  const memberUnitIds = isCouncilAdmin ? new Set<string>() : new Set(await getOrgUnitIdsForUser(user.id))
  return { isCouncilAdmin, userId: user.id, memberUnitIds }
}

function inAnyUnit(ctx: EventAuthzContext, unitIds: readonly string[]): boolean {
  return unitIds.some((id) => ctx.memberUnitIds.has(id))
}

export function canManageEvent(
  ctx: EventAuthzContext,
  event: { readonly createdBy: string; readonly committeeIds: readonly string[] },
): boolean {
  return ctx.isCouncilAdmin || event.createdBy === ctx.userId || inAnyUnit(ctx, event.committeeIds)
}

export function canPublishEvent(ctx: EventAuthzContext, committeeIds: readonly string[]): boolean {
  return ctx.isCouncilAdmin || inAnyUnit(ctx, committeeIds)
}

/** Committee ids the caller may not newly attach (empty = allowed). */
export function forbiddenCommitteeTags(
  ctx: EventAuthzContext,
  requested: readonly string[],
  existing: readonly string[] = [],
): string[] {
  if (ctx.isCouncilAdmin) return []
  const keep = new Set(existing)
  return requested.filter((id) => !keep.has(id) && !ctx.memberUnitIds.has(id))
}
