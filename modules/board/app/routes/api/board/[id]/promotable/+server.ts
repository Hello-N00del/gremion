import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { Role, hasRole } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { resolveBoardOrgUnitScope } from '$lib/server/board/scope'
import { resolveBoardBackendOr503 } from '$lib/server/board/backend/resolve'
import { getDb } from '$lib/server/db'
import { getDisplayNameResolver } from '$lib/server/identity/display-names'

// GET /api/board/[id]/promotable — open (un-promoted, not-done) protocol action
// items for the board's org-unit, available to promote into a card.
//
// The board membership check goes through the BoardBackendPort (backend.getBoard).
// The kernel-owned half (protocol_action_items/protocols) stays a direct getDb()
// read; the board-owned half (which items already have a card) goes through
// backend.listPromotedActionItemIds so it reads the CORRECT card table under
// BOARD_BACKEND=service (the leaf's own DB — #384, board-cutover.md gap #1).
// The filter runs in code, preserving the former single-query result exactly
// (same items, same ORDER BY p.meeting_date DESC, ai.created_at order).
export const GET: RequestHandler = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) throw error(403, 'Forbidden')
  const resolved = resolveBoardBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  const board = await backend.getBoard(params.id)
  if (!board) throw error(404, 'Board nicht gefunden')
  const ouIds = await resolveBoardOrgUnitScope({ userId: user.id, roles: user.roles })
  if (!ouIds.includes(board.org_unit_id)) throw error(403, 'Kein Zugriff')

  const sql = getDb()
  const openItems = await sql<
    Array<{ id: string; text: string; assignee_keycloak_id: string | null; due_date: string | null; meeting_date: string }>
  >`
    SELECT ai.id, ai.text, ai.assignee_keycloak_id, ai.due_date, p.meeting_date
    FROM protocol_action_items ai
    JOIN protocols p ON p.id = ai.protocol_id
    WHERE p.committee_id = ${board.org_unit_id}
      AND ai.completed = false
    ORDER BY p.meeting_date DESC, ai.created_at
  `
  const promoted = new Set(await backend.listPromotedActionItemIds(openItems.map((i) => i.id)))
  const items = openItems.filter((i) => !promoted.has(i.id))

  const names = await getDisplayNameResolver().resolveMany(
    items.map((i) => i.assignee_keycloak_id).filter((x): x is string => !!x),
  )
  return json({
    data: items.map((i) => {
      const { assignee_keycloak_id, ...rest } = i
      return { ...rest, assignee_name: assignee_keycloak_id ? (names.get(assignee_keycloak_id) ?? null) : null }
    }),
  })
}
