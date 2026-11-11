import { error, json } from '@sveltejs/kit'
import { z } from 'zod'
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

// Default shape of a body's board: the same three-column flow the seed uses.
const DEFAULT_BOARD_NAME = 'Aufgaben'
const DEFAULT_STACKS = ['Offen', 'In Arbeit', 'Erledigt']

// z.guid(), not z.uuid(): the dev seed units carry non-RFC ids (version nibble 0).
const createSchema = z.object({ orgUnitId: z.guid() })

// POST /api/board — a member creates the (single, live) board of an org-unit
// they belong to. Scope is the same resolver the reads use, so a user cannot
// create a board for a body they are not in (it-admin: all units). 409 carries
// the existing board id so the client can simply open it. No personal data is
// logged here.
export const POST: RequestHandler = async ({ request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) throw error(403, 'Forbidden')
  const resolved = resolveBoardBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw error(400, 'orgUnitId muss eine gültige ID sein')
  const { orgUnitId } = parsed.data
  const ouIds = await resolveBoardOrgUnitScope({ userId: user.id, roles: user.roles })
  if (!ouIds.includes(orgUnitId)) throw error(403, 'Kein Zugriff')
  const existing = (await backend.listBoardsForOrgUnits([orgUnitId])).find(
    (b) => b.org_unit_id === orgUnitId && !b.archived,
  )
  if (existing) {
    return json({ message: 'Für dieses Gremium gibt es bereits ein Board', data: { id: existing.id } }, { status: 409 })
  }
  const created = await backend.createBoard({ orgUnitId, name: DEFAULT_BOARD_NAME, stacks: DEFAULT_STACKS })
  return json({ data: { id: created.board.id } }, { status: 201 })
}
