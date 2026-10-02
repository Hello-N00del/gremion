import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { z } from 'zod'
import { Role, hasRole } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { resolveBoardOrgUnitScope } from '$lib/server/board/scope'
import { resolveBoardBackendOr503 } from '$lib/server/board/backend/resolve'
import type { BoardBackendPort } from '$lib/server/board/backend'

// Shared gate: authenticated member + the board's org-unit is in the user's scope.
async function gate(locals: App.Locals, boardId: string, backend: BoardBackendPort): Promise<SessionUser> {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) throw error(403, 'Forbidden')
  const board = await backend.getBoard(boardId)
  if (!board) throw error(404, 'Board nicht gefunden')
  const ouIds = await resolveBoardOrgUnitScope({ userId: user.id, roles: user.roles })
  if (!ouIds.includes(board.org_unit_id)) throw error(403, 'Kein Zugriff')
  return user
}

const createSchema = z.object({
  stackId: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  assigneeKeycloakId: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
})
const moveSchema = z.object({ cardId: z.string().min(1), stackId: z.string().min(1), order: z.number().int().min(0) })

// POST /api/board/[id]/cards — create a card.
export const POST: RequestHandler = async ({ params, request, locals }) => {
  const resolved = resolveBoardBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  const user = await gate(locals, params.id, backend)
  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw error(400, parsed.error.issues.map((i) => i.message).join(', '))
  const card = await backend.createCard({ ...parsed.data, createdBy: user.id })
  return json({ data: card }, { status: 201 })
}

// PATCH /api/board/[id]/cards — move/reorder a card (its stack = its status).
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  const resolved = resolveBoardBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  await gate(locals, params.id, backend)
  const parsed = moveSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw error(400, parsed.error.issues.map((i) => i.message).join(', '))
  const card = await backend.moveCard(parsed.data.cardId, { stackId: parsed.data.stackId, order: parsed.data.order })
  if (!card) throw error(404, 'Karte nicht gefunden')
  return json({ data: card })
}
