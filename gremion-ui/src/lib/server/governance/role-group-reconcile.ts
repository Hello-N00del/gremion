// src/lib/server/governance/role-group-reconcile.ts
// Audit 420 (item 1): role → flat-Keycloak-group grants used to be ADD-ONLY.
// The role-assign route granted the mapped ref-finanzen* groups to the incoming
// holder (register.server.ts resolver seam) but nothing ever removed them from
// the OUTGOING holder — so an ex-officer kept finance authz forever, because
// finance authz is derived at request time from the KC `groups` token claim
// (scope.ts hasFinanceGroup / group-helpers.ts).
//
// RECONCILE MODEL (replaces the earlier add-only + narrow reassign-revoke logic):
//
//  - UNIVERSE  — the union of resolveRoleGroupGrants(role) over EVERY defined
//                governance role (listAllRoleNames()). Every flat KC group any
//                role could ever grant. A group outside this set (e.g. the
//                manually-assigned -belege receipts-clerk group, which has no
//                governance-role hook by design) is NEVER touched by
//                reconciliation — the universe is the removable allowlist.
//  - DERIVED   — for one user, the union of resolveRoleGroupGrants(role) over
//                the names of their remaining ACTIVE (status active|grace)
//                assignments, across ALL committees (listActiveRoleNamesForUser).
//                A user holding the same group via two active assignments keeps
//                it once either alone would still derive it (natural union).
//  - CURRENT   — the user's actual live KC group membership.
//
// After ANY mutation of a user's assignments (assign, re-assign, unassign,
// status → inactive), the user's groups WITHIN the universe must equal DERIVED:
// add what's missing, remove what's no longer derivable. Groups outside the
// universe are left exactly as they are.
import { resolveRoleGroupGrants } from '$lib/server/modules/runtime-registry'
import type { KeycloakAdminClient } from '$lib/server/keycloak-admin'
import { listAllRoleNames, listActiveRoleNamesForUser } from './governance-db'

/** Union of resolveRoleGroupGrants(name) over `roleNames`, deduplicated. Pure. */
export function unionRoleGroupGrants(roleNames: readonly string[]): string[] {
  const groups = new Set<string>()
  for (const name of roleNames) {
    for (const g of resolveRoleGroupGrants(name)) groups.add(g)
  }
  return [...groups]
}

/**
 * The pure reconcile decision: given the auto-managed UNIVERSE, what a user's
 * groups should be DERIVED to from their remaining active assignments, and what
 * they CURRENTLY hold in Keycloak — which groups to add and which to remove.
 *
 *  - `toAdd`    — in derived, not yet current.
 *  - `toRemove` — currently held, inside the universe (so the grant machinery
 *                 could plausibly have issued it), but no longer derivable. A
 *                 group outside the universe is never a candidate for removal,
 *                 even if it happens to also be in `current` (a manual grant is
 *                 left alone).
 */
export function planGroupReconcile(
  universe: readonly string[],
  derived: readonly string[],
  current: readonly string[],
): { toAdd: string[]; toRemove: string[] } {
  const universeSet = new Set(universe)
  const derivedSet = new Set(derived)
  const currentSet = new Set(current)
  const toAdd = derived.filter((g) => !currentSet.has(g))
  const toRemove = [...currentSet].filter((g) => universeSet.has(g) && !derivedSet.has(g))
  return { toAdd, toRemove }
}

/**
 * Reconcile ONE user's flat-Keycloak-group membership against their current
 * active committee-role assignments. The single entry point every mutation path
 * (assign / re-assign / unassign / a future status-change-to-inactive caller)
 * should call after writing its DB change — so they all converge through the
 * same decision instead of each re-deriving add/revoke logic. Best-effort by
 * design: the caller wraps this in its own try/catch so a Keycloak hiccup here
 * never rolls back or fails the assignment DB write that already committed.
 *
 * `groupIdByName` may be supplied by a caller that already fetched kc.listGroups()
 * for another purpose in the same request (the role-assign route does, to grant
 * the incoming holder) — avoids a redundant round trip when reconciling more than
 * one user in the same request.
 */
export async function reconcileUserRoleGroups(
  userKeycloakId: string,
  kc: KeycloakAdminClient,
  groupIdByName?: ReadonlyMap<string, string>,
): Promise<void> {
  const [allRoleNames, activeRoleNames, currentGroups] = await Promise.all([
    listAllRoleNames(),
    listActiveRoleNamesForUser(userKeycloakId),
    kc.listUserGroups(userKeycloakId),
  ])
  const universe = unionRoleGroupGrants(allRoleNames)
  const derived = unionRoleGroupGrants(activeRoleNames)
  const current = currentGroups.map((g) => g.name)
  const { toAdd, toRemove } = planGroupReconcile(universe, derived, current)
  if (toAdd.length === 0 && toRemove.length === 0) return

  const idByName = groupIdByName ?? new Map((await kc.listGroups()).map((g) => [g.name, g.id]))
  for (const name of toAdd) {
    const groupId = idByName.get(name)
    if (groupId) await kc.addUserToGroup(userKeycloakId, groupId)
  }
  for (const name of toRemove) {
    const groupId = idByName.get(name)
    if (groupId) await kc.removeUserFromGroup(userKeycloakId, groupId)
  }
}
