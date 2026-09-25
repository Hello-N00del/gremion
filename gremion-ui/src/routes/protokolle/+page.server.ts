import type { PageServerLoad } from './$types'
import { listProtocols } from '$lib/server/governance/protocols-db'
import { hasRole, Role } from '$lib/auth'

// Aggregates every committee's meeting minutes (see protocols-db.listProtocols).
// DB unavailability degrades to an empty list → first-class empty state.
//
// TASK-009 kernel lane (F1 drift): the product's own /protocols page had the
// same defect and was fixed by threading isAdmin through (c33778d6) — the
// kernel's /protokolle list drifted from that fix. isAdmin is gated on
// Role.CouncilAdmin, the exact permission the per-committee protocol editor
// page already enforces for writes (see
// members/committees/[id]/protokolle/[protocolId]/+page.svelte's own
// `isAdmin = hasRole(user.roles, Role.CouncilAdmin)`), so this never widens
// access: a non-admin reaching the editor route directly still only gets the
// read view that route already allows.
export const load: PageServerLoad = async (event) => {
  const protocols = await listProtocols().catch(() => [])
  const roles = event.locals?.user?.roles ?? []
  const isAdmin = hasRole(roles, Role.CouncilAdmin)
  return { protocols, isAdmin }
}
