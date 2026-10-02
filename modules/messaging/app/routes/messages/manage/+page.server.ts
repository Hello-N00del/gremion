// src/routes/messages/manage/+page.server.ts
//
// FLOW-MSG-001 (TASK-009 lane B, rows-plan.md row 14 / S2.6): the
// "Verwaltung -> Räume" overview — one row per org unit, its room's ledger
// state, and whether Matrix itself is reachable (PRD-DEP-002/004).
//
// Gate: CouncilAdmin (ITAdmin inherits, lib/auth/index.ts role hierarchy).
// The hooks-level PAGE_ACCESS only sees the top-level 'messages' segment
// (Role.Member — the whole-app Matrix chat stays member-reachable), so this
// load re-checks the stricter role itself, exactly like /systemstatus's own
// pattern of a route-local gate layered on top of the coarse hooks check.
import { error } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { listOrgUnits } from '$lib/server/governance/org-units-db'
import { listOverview } from '$lib/server/messages/admin/room-admin'

export const load: PageServerLoad = async ({ locals }) => {
  const user = locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  if (!hasRole(user.roles, Role.CouncilAdmin)) throw error(403, 'Forbidden')

  // listOverview never throws (room-admin.ts: every per-unit ledger read and
  // the Matrix reachability probe are each caught individually), so the page
  // never 500s even with Matrix down or a single unit's ledger read failing
  // (PRD-DEP-004) — no extra try/catch needed at this layer.
  const units = await listOrgUnits()
  return listOverview(units.map((u) => ({ id: u.id, name: u.name })))
}
