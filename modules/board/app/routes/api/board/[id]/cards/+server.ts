import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { z } from 'zod'
import { Role, hasRole } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { resolveBoardOrgUnitScope } from '$lib/server/board/scope'
import { resolveBoardBackendOr503 } from '$lib/server/board/backend/resolve'
import type { BoardBackendPort } from '$lib/server/board/backend'
import { isMemberOf } from '$lib/server/governance/org-units-db'

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
// A card edit names the card and the fields to change; a field left out stays as it is.
// An emptied description is stored as null; the due date is a real calendar day, ISO.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum muss JJJJ-MM-TT sein')
  .refine((v) => {
    // a refinement also runs on a string the regex refused, and Date#toISOString throws on Invalid Date
    const d = new Date(`${v}T00:00:00Z`)
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v)
  }, 'Datum existiert nicht')
const editSchema = z
  .object({
    cardId: z.string().min(1),
    title: z.string().trim().min(1).max(200).optional(),
    description: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .transform((v) => (v === undefined ? undefined : v === null || v.trim() === '' ? null : v)),
    assigneeKeycloakId: z.string().regex(UUID, 'Ungültige Person').nullable().optional(),
    dueDate: isoDay.nullable().optional(),
  })
  .refine(
    (v) => v.title !== undefined || v.description !== undefined || v.assigneeKeycloakId !== undefined || v.dueDate !== undefined,
    'Nichts zu ändern',
  )
const moveSchema = z.object({ cardId: z.string().min(1), stackId: z.string().min(1), order: z.number().int().min(0) })

// R29-BOARD-STORE-S B12 (OWASP API1:2023, BOLA): the gate binds only params.id
// to the user's scope. Every other id the body names must belong to THAT board,
// else 404 — not 403, so the route is no existence oracle for other units' ids.
// The membership test runs on backend.deckFor(params.id), the board the gate
// just scoped.

// POST /api/board/[id]/cards — create a card.
export const POST: RequestHandler = async ({ params, request, locals }) => {
  const resolved = resolveBoardBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  const user = await gate(locals, params.id, backend)
  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw error(400, parsed.error.issues.map((i) => i.message).join(', '))
  const deck = await backend.deckFor(params.id)
  if (!deck.stacks.some((s) => s.id === parsed.data.stackId)) throw error(404, 'Stapel nicht gefunden')
  const card = await backend.createCard({ ...parsed.data, createdBy: user.id })
  return json({ data: card }, { status: 201 })
}

// PATCH /api/board/[id]/cards — two verbs on one gate:
//   body names a stackId → move/reorder a card (its stack = its status);
//   otherwise            → edit it (title, description, assignee, due date).
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  const resolved = resolveBoardBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  await gate(locals, params.id, backend)
  const raw = await request.json().catch(() => null)
  const isMove = typeof raw === 'object' && raw !== null && 'stackId' in raw
  if (!isMove) return editCard(params.id, raw, backend)
  const parsed = moveSchema.safeParse(raw)
  if (!parsed.success) throw error(400, parsed.error.issues.map((i) => i.message).join(', '))
  const deck = await backend.deckFor(params.id)
  if (!deck.cards.some((c) => c.id === parsed.data.cardId)) throw error(404, 'Karte nicht gefunden')
  if (!deck.stacks.some((s) => s.id === parsed.data.stackId)) throw error(404, 'Stapel nicht gefunden')
  const card = await backend.moveCard(parsed.data.cardId, { stackId: parsed.data.stackId, order: parsed.data.order })
  if (!card) throw error(404, 'Karte nicht gefunden')
  return json({ data: card })
}

// The edit shares the move's gate (member + board in scope) and its BOLA check: the card must be
// on THIS board. The assignee must be a member of the board's own body (also checked here, never
// trusted from the client); null clears it.
async function editCard(boardId: string, raw: unknown, backend: BoardBackendPort): Promise<Response> {
  const parsed = editSchema.safeParse(raw)
  if (!parsed.success) throw error(400, parsed.error.issues.map((i) => i.message).join(', '))
  const { cardId, ...patch } = parsed.data
  const deck = await backend.deckFor(boardId)
  if (!deck.cards.some((c) => c.id === cardId)) throw error(404, 'Karte nicht gefunden')
  if (patch.assigneeKeycloakId && !(await isMemberOf(deck.board.org_unit_id, patch.assigneeKeycloakId))) {
    throw error(400, 'Die Person ist kein Mitglied dieses Gremiums')
  }
  // zod leaves undefined keys on the object: send only what the caller named
  const named = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
  const card = await backend.updateCard(cardId, named)
  if (!card) throw error(404, 'Karte nicht gefunden')
  return json({ data: card })
}
