import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { Role, hasRole } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { resolveBoardOrgUnitScope } from '$lib/server/board/scope'
import { resolveBoardBackendOr503 } from '$lib/server/board/backend/resolve'

// GET /api/board/[id] — one board's deck (board + stacks + cards), gated to
// org-units the user is scoped to.
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
  if (!ouIds.includes(board.org_unit_id)) throw error(403, 'Kein Zugriff auf dieses Board')
  return json({ data: await backend.deckFor(params.id) })
}
