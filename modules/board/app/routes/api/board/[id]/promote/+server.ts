import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { z } from 'zod'
import { Role, hasRole } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { resolveBoardOrgUnitScope } from '$lib/server/board/scope'
import { resolveBoardBackendOr503 } from '$lib/server/board/backend/resolve'
import { getActionItem, getProtocol } from '$lib/server/protocols/protocol-db'

const schema = z.object({ actionItemId: z.string().min(1) })

// POST /api/board/[id]/promote — link a protocol action item into the board's
// first stack as a "Sitzung" card. Idempotent on protocol_action_item_id.
//
// getActionItem() reads the kernel-owned protocol_action_items table and stays
// in-process; the RESOLVED item is then handed to the BoardBackendPort so the
// board leaf never reads protocol data (design §8 cross-DB rule).
export const POST: RequestHandler = async ({ params, request, locals }) => {
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
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw error(400, 'actionItemId fehlt')
  const item = await getActionItem(parsed.data.actionItemId)
  if (!item) throw error(404, 'Aufgabe nicht gefunden')
  // R29-BOARD-STORE-S B12 (OWASP API1:2023, BOLA): the item must come from a
  // protocol of THIS board's committee — the predicate /promotable lists by
  // (p.committee_id = board.org_unit_id). 404, not 403: no existence oracle.
  const protocol = await getProtocol(item.protocol_id)
  if (!protocol || protocol.committee_id !== board.org_unit_id) throw error(404, 'Aufgabe nicht gefunden')
  const card = await backend.promoteActionItem(
    params.id,
    { id: item.id, text: item.text, assigneeKeycloakId: item.assignee_keycloak_id, dueDate: item.due_date },
    user.id,
  )
  return json({ data: card }, { status: 201 })
}
