import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { Role, hasRole } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { resolveBoardOrgUnitScope } from '$lib/server/board/scope'
import { resolveBoardBackendOr503 } from '$lib/server/board/backend/resolve'

// GET /api/board — boards the current user may see (org-unit scoped).
export const GET: RequestHandler = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) throw error(403, 'Forbidden')
  const resolved = resolveBoardBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  const ouIds = await resolveBoardOrgUnitScope({ userId: user.id, roles: user.roles })
  const boards = await backend.listBoardsForOrgUnits(ouIds)
  return json({
    data: boards.filter((b) => !b.archived),
    archivedCount: boards.filter((b) => b.archived).length,
  })
}
