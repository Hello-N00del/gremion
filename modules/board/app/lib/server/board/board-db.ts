// src/lib/server/board/board-db.ts
//
// WI-6 Deck task board repository. Mirrors the org-units-db house style:
// getDb(), plain exported functions + a namespaced `boardDb` object.
// A card's status IS the stack it sits in; promote links (not copies) a
// protocol action item via card.protocol_action_item_id (idempotent).
import { getDb } from '../db'

export interface Board {
  readonly id: string
  readonly org_unit_id: string
  readonly name: string
  readonly archived: boolean
  readonly created_at: Date
}

export interface Stack {
  readonly id: string
  readonly board_id: string
  readonly name: string
  readonly sort_order: number
}

export interface Card {
  readonly id: string
  readonly stack_id: string
  readonly title: string
  readonly description: string | null
  readonly assignee_keycloak_id: string | null
  readonly due_date: string | null
  readonly label: string | null
  readonly sort_order: number
  readonly protocol_action_item_id: string | null
  readonly created_by: string | null
  readonly created_at: Date
}

export async function createBoard(data: { orgUnitId: string; name: string; archived?: boolean }): Promise<Board> {
  const rows = await getDb()<Board[]>`
    INSERT INTO board (org_unit_id, name, archived)
    VALUES (${data.orgUnitId}, ${data.name}, ${data.archived ?? false}) RETURNING *`
  return rows[0]!
}

export async function listBoardsForOrgUnits(orgUnitIds: readonly string[]): Promise<readonly Board[]> {
  if (orgUnitIds.length === 0) return []
  const sql = getDb()
  return sql<Board[]>`SELECT * FROM board WHERE org_unit_id IN ${sql(orgUnitIds as string[])} ORDER BY archived, name`
}

export async function getBoard(id: string): Promise<Board | null> {
  const rows = await getDb()<Board[]>`SELECT * FROM board WHERE id = ${id}`
  return rows[0] ?? null
}

/**
 * R29-BOARD-STORE-S B5 (Q7): a board and its stacks (sort_order = position) in
 * ONE transaction, so a failing stack insert leaves no board — the in-process
 * twin of the leaf's POST /api/v1/boards. Same INSERTs as createBoard /
 * createStack, run on the transaction handle of the tenant's own getDb().
 */
export async function createBoardWithStacks(data: {
  orgUnitId: string
  name: string
  archived?: boolean
  stacks?: readonly string[]
}): Promise<{ board: Board; stacks: Stack[] }> {
  return getDb().begin(async (tx) => {
    const [board] = await tx<Board[]>`
      INSERT INTO board (org_unit_id, name, archived)
      VALUES (${data.orgUnitId}, ${data.name}, ${data.archived ?? false}) RETURNING *`
    const stacks: Stack[] = []
    for (const [order, name] of (data.stacks ?? []).entries()) {
      const [stack] = await tx<Stack[]>`
        INSERT INTO stack (board_id, name, sort_order) VALUES (${board!.id}, ${name}, ${order}) RETURNING *`
      stacks.push(stack!)
    }
    return { board: board!, stacks }
  }) as Promise<{ board: Board; stacks: Stack[] }>
}

export async function createStack(data: { boardId: string; name: string; order: number }): Promise<Stack> {
  const rows = await getDb()<Stack[]>`
    INSERT INTO stack (board_id, name, sort_order) VALUES (${data.boardId}, ${data.name}, ${data.order}) RETURNING *`
  return rows[0]!
}

export async function createCard(data: {
  stackId: string
  title: string
  description?: string | null
  assigneeKeycloakId?: string | null
  dueDate?: string | null
  label?: string | null
  order?: number
  protocolActionItemId?: string | null
  createdBy?: string | null
}): Promise<Card> {
  const rows = await getDb()<Card[]>`
    INSERT INTO card (stack_id, title, description, assignee_keycloak_id, due_date, label, sort_order, protocol_action_item_id, created_by)
    VALUES (${data.stackId}, ${data.title}, ${data.description ?? null}, ${data.assigneeKeycloakId ?? null},
            ${data.dueDate ?? null}, ${data.label ?? null}, ${data.order ?? 0}, ${data.protocolActionItemId ?? null}, ${data.createdBy ?? null})
    RETURNING *`
  return rows[0]!
}

export async function moveCard(id: string, to: { stackId: string; order: number }): Promise<Card | null> {
  const rows = await getDb()<Card[]>`
    UPDATE card SET stack_id = ${to.stackId}, sort_order = ${to.order} WHERE id = ${id} RETURNING *`
  return rows[0] ?? null
}

export async function updateCard(
  id: string,
  patch: { title?: string; description?: string | null; assigneeKeycloakId?: string | null; dueDate?: string | null; label?: string | null },
): Promise<Card | null> {
  const sql = getDb()
  const rows = await sql<Card[]>`
    UPDATE card SET
      title = COALESCE(${patch.title ?? null}, title),
      description = ${patch.description !== undefined ? patch.description : sql`description`},
      assignee_keycloak_id = ${patch.assigneeKeycloakId !== undefined ? patch.assigneeKeycloakId : sql`assignee_keycloak_id`},
      due_date = ${patch.dueDate !== undefined ? patch.dueDate : sql`due_date`},
      label = ${patch.label !== undefined ? patch.label : sql`label`}
    WHERE id = ${id} RETURNING *`
  return rows[0] ?? null
}

export async function deckFor(boardId: string): Promise<{ board: Board; stacks: readonly Stack[]; cards: readonly Card[] }> {
  const board = await getBoard(boardId)
  if (!board) throw new Error('board not found')
  const sql = getDb()
  const stacks = await sql<Stack[]>`SELECT * FROM stack WHERE board_id = ${boardId} ORDER BY sort_order`
  const cards = await sql<Card[]>`
    SELECT c.* FROM card c JOIN stack s ON c.stack_id = s.id
    WHERE s.board_id = ${boardId} ORDER BY c.sort_order`
  return { board, stacks, cards }
}

// Promote a protocol action item into a card in the board's first stack.
// Idempotent: the partial unique index on protocol_action_item_id guards dups.
export async function promoteActionItem(
  boardId: string,
  item: { id: string; text: string; assigneeKeycloakId: string | null; dueDate: string | null },
  createdBy: string,
): Promise<Card> {
  const sql = getDb()
  const stacks = await sql<Stack[]>`SELECT * FROM stack WHERE board_id = ${boardId} ORDER BY sort_order LIMIT 1`
  const first = stacks[0]
  if (!first) throw new Error('board has no stacks')
  const rows = await sql<Card[]>`
    INSERT INTO card (stack_id, title, assignee_keycloak_id, due_date, label, protocol_action_item_id, created_by)
    VALUES (${first.id}, ${item.text}, ${item.assigneeKeycloakId}, ${item.dueDate}, 'Sitzung', ${item.id}, ${createdBy})
    ON CONFLICT (protocol_action_item_id) WHERE protocol_action_item_id IS NOT NULL DO UPDATE SET title = EXCLUDED.title
    RETURNING *`
  return rows[0]!
}

// #384 — the board-owned half of the /promotable filter. Returns the subset of
// the given protocol-action-item ids that already have a card. Same semantics
// as the route's former `NOT EXISTS (SELECT 1 FROM card c WHERE
// c.protocol_action_item_id = ai.id)`: any card counts, NOT board-scoped
// (mirrors the global partial unique index on protocol_action_item_id).
export async function listPromotedActionItemIds(candidateIds: readonly string[]): Promise<readonly string[]> {
  if (candidateIds.length === 0) return []
  const sql = getDb()
  const rows = await sql<{ protocol_action_item_id: string }[]>`
    SELECT c.protocol_action_item_id FROM card c
    WHERE c.protocol_action_item_id IN ${sql(candidateIds as string[])}`
  return rows.map((r) => r.protocol_action_item_id)
}

export const boardDb = {
  createBoard,
  createBoardWithStacks,
  listBoardsForOrgUnits,
  getBoard,
  createStack,
  createCard,
  moveCard,
  updateCard,
  deckFor,
  promoteActionItem,
  listPromotedActionItemIds,
} as const
