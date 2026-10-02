import type { PageServerLoad } from './$types'
import { listProtocols } from '$lib/server/governance/protocols-db'
import { hasRole, Role } from '$lib/auth'
import { filterVisibleProtocols, visibleProtocolsWithoutMembership } from '$lib/server/governance/visibility'

// Aggregates every committee's meeting minutes (see protocols-db.listProtocols).
// DB unavailability degrades to an empty list → first-class empty state.
//
// #458-2: the degrade stays, the SILENCE does not. A bare `.catch(() => [])`
// made a genuine query fault indistinguishable from "no protocols published" —
// the page rendered its empty state and nothing was recorded anywhere. Log
// before degrading.
//
// Log a SUMMARY, never the raw error object. postgres.js attaches the failing
// `query` and its bound `parameters` to its Error, so `console.error(..., err)`
// would put tenant ids and row filter values into the container log.
// `name: message (code)`; the SQLSTATE is what tells an operator what broke.
function summarize(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const code = (err as { code?: unknown }).code
  const suffix = typeof code === 'string' || typeof code === 'number' ? ` (code ${code})` : ''
  return `${err.name}: ${err.message}${suffix}`
}
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
//
// R29-F104-KTWIN (kernel twin of F1-FIX-04 / H19, operator decision D-3): the
// page is Guest-reachable, so the rows go through the ONE visibility rule
// (governance/visibility.ts): a Guest sees only published protocols of
// all_members units, a Member additionally the all_members drafts and their own
// units, a CouncilAdmin everything. A failed membership lookup fails CLOSED
// (only the rows that need no membership stay) and is logged, never swallowed.
export const load: PageServerLoad = async (event) => {
  const rows = await listProtocols().catch((err) => {
    console.error('[protokolle] listProtocols failed, degrading to empty:', summarize(err))
    return []
  })
  const user = event.locals?.user
  const viewer = user ? { id: user.id, roles: user.roles ?? [] } : null
  const protocols = await filterVisibleProtocols(viewer, rows).catch((err) => {
    console.error('[protokolle] membership lookup failed, showing only rows that need no membership:', summarize(err))
    return visibleProtocolsWithoutMembership(viewer, rows)
  })
  const roles = user?.roles ?? []
  const isAdmin = hasRole(roles, Role.CouncilAdmin)
  return { protocols, isAdmin }
}
