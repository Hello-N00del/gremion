import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../db'
import { createOrgUnit } from '../governance/org-units-db'
import { boardDb } from './board-db'

async function anOrgUnit() {
  return createOrgUnit({
    name: 'StuRa',
    description: null,
    parentId: null,
    kind: 'council',
    visibility: 'all_members',
    wantsMatrixRoom: false,
    wantsNextcloudFolder: false,
    childTerm: null,
  })
}

describe('board-db', () => {
  beforeEach(async () => {
    // Only the board tables need clearing for isolation. We deliberately do NOT
    // DELETE org_units here: a sibling integration file (seed/finance) can leave
    // finance.finance_unit rows that FK-reference org_units, so a bare
    // DELETE FROM org_units would fail with a foreign-key violation. Each test
    // creates its own org unit (org_units has no unique-name constraint, so any
    // leftover rows from other files are harmless to these assertions).
    const sql = getDb()
    await sql`TRUNCATE card, stack, board RESTART IDENTITY CASCADE`
  })

  it('creates a board with stacks and lists the deck', async () => {
    const ou = await anOrgUnit()
    const board = await boardDb.createBoard({ orgUnitId: ou.id, name: 'StuRa-Plenum' })
    const s1 = await boardDb.createStack({ boardId: board.id, name: 'Offen', order: 0 })
    const s2 = await boardDb.createStack({ boardId: board.id, name: 'Erledigt', order: 1 })
    const card = await boardDb.createCard({ stackId: s1.id, title: 'Protokoll finalisieren', createdBy: 'anna.berger' })

    const deck = await boardDb.deckFor(board.id)
    expect(deck.board.name).toBe('StuRa-Plenum')
    expect(deck.stacks.map((s) => s.name)).toEqual(['Offen', 'Erledigt'])
    expect(deck.cards).toHaveLength(1)
    expect(deck.cards[0].stack_id).toBe(s1.id)

    await boardDb.moveCard(card.id, { stackId: s2.id, order: 0 })
    const deck2 = await boardDb.deckFor(board.id)
    expect(deck2.cards[0].stack_id).toBe(s2.id)
  })

  it('lists boards for a set of org units (archived included, flagged)', async () => {
    const ou = await anOrgUnit()
    await boardDb.createBoard({ orgUnitId: ou.id, name: 'Aktiv' })
    await boardDb.createBoard({ orgUnitId: ou.id, name: 'Alt', archived: true })
    const boards = await boardDb.listBoardsForOrgUnits([ou.id])
    expect(boards.map((b) => b.name).sort()).toEqual(['Aktiv', 'Alt'])
  })

  it('promote is idempotent on protocol_action_item_id', async () => {
    const ou = await anOrgUnit()
    const board = await boardDb.createBoard({ orgUnitId: ou.id, name: 'B' })
    await boardDb.createStack({ boardId: board.id, name: 'Offen', order: 0 })
    const sql = getDb()
    const [proto] = await sql<{ id: string }[]>`
      INSERT INTO protocols (committee_id, meeting_date, title, created_by)
      VALUES (${ou.id}, '2026-01-01', 'Sitzung', 'u1') RETURNING id`
    const [item] = await sql<{ id: string }[]>`
      INSERT INTO protocol_action_items (protocol_id, text) VALUES (${proto.id}, 'Aufgabe X') RETURNING id`

    const c1 = await boardDb.promoteActionItem(board.id, { id: item.id, text: 'Aufgabe X', assigneeKeycloakId: null, dueDate: null }, 'u1')
    const c2 = await boardDb.promoteActionItem(board.id, { id: item.id, text: 'Aufgabe X', assigneeKeycloakId: null, dueDate: null }, 'u1')
    expect(c1.id).toBe(c2.id)
    const [{ n }] = await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM card WHERE protocol_action_item_id = ${item.id}`
    expect(Number(n)).toBe(1)
  })

  // #384 — inprocess parity: the promotable route's new shape (open-items query
  // + boardDb.listPromotedActionItemIds + in-code filter) must reproduce the old
  // single-query `NOT EXISTS (SELECT 1 FROM card …)` result EXACTLY — same
  // items, same ORDER BY p.meeting_date DESC, ai.created_at order.
  it('listPromotedActionItemIds + code filter matches the old NOT EXISTS query (parity, #384)', async () => {
    const ou = await anOrgUnit()
    const board = await boardDb.createBoard({ orgUnitId: ou.id, name: 'B' })
    await boardDb.createStack({ boardId: board.id, name: 'Offen', order: 0 })
    const sql = getDb()
    const [pNew] = await sql<{ id: string }[]>`
      INSERT INTO protocols (committee_id, meeting_date, title, created_by)
      VALUES (${ou.id}, '2026-02-01', 'Sitzung Neu', 'u1') RETURNING id`
    const [pOld] = await sql<{ id: string }[]>`
      INSERT INTO protocols (committee_id, meeting_date, title, created_by)
      VALUES (${ou.id}, '2026-01-01', 'Sitzung Alt', 'u1') RETURNING id`
    // Three open items (two on the older protocol → exercises the created_at
    // tiebreak), one completed item, one item that gets promoted.
    const [aiNew] = await sql<{ id: string }[]>`
      INSERT INTO protocol_action_items (protocol_id, text) VALUES (${pNew.id}, 'Neu offen') RETURNING id`
    const [aiOld1] = await sql<{ id: string }[]>`
      INSERT INTO protocol_action_items (protocol_id, text) VALUES (${pOld.id}, 'Alt offen 1') RETURNING id`
    const [aiOld2] = await sql<{ id: string }[]>`
      INSERT INTO protocol_action_items (protocol_id, text) VALUES (${pOld.id}, 'Alt offen 2') RETURNING id`
    await sql`
      INSERT INTO protocol_action_items (protocol_id, text, completed) VALUES (${pOld.id}, 'Erledigt', true)`
    await boardDb.promoteActionItem(board.id, { id: aiOld1.id, text: 'Alt offen 1', assigneeKeycloakId: null, dueDate: null }, 'u1')

    // OLD shape (verbatim pre-#384 route SQL).
    const oldResult = await sql<{ id: string }[]>`
      SELECT ai.id, ai.text, ai.assignee_keycloak_id, ai.due_date, p.meeting_date
      FROM protocol_action_items ai
      JOIN protocols p ON p.id = ai.protocol_id
      WHERE p.committee_id = ${ou.id}
        AND ai.completed = false
        AND NOT EXISTS (SELECT 1 FROM card c WHERE c.protocol_action_item_id = ai.id)
      ORDER BY p.meeting_date DESC, ai.created_at`

    // NEW shape (post-#384 route logic).
    const openItems = await sql<{ id: string }[]>`
      SELECT ai.id, ai.text, ai.assignee_keycloak_id, ai.due_date, p.meeting_date
      FROM protocol_action_items ai
      JOIN protocols p ON p.id = ai.protocol_id
      WHERE p.committee_id = ${ou.id}
        AND ai.completed = false
      ORDER BY p.meeting_date DESC, ai.created_at`
    const promoted = new Set(await boardDb.listPromotedActionItemIds(openItems.map((i) => i.id)))
    const newResult = openItems.filter((i) => !promoted.has(i.id))

    expect(newResult).toEqual(oldResult)
    expect(newResult.map((i) => i.id)).toEqual([aiNew.id, aiOld2.id])
    expect(await boardDb.listPromotedActionItemIds([])).toEqual([])
  })
})
