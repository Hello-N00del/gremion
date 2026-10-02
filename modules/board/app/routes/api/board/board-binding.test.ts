// R29-BOARD-STORE-S B12 — intra-tenant object binding in the web tier (OWASP
// API1:2023, BOLA; Q10). The board routes check that params.id's board is in
// the user's org-unit scope; every OTHER id the request names must belong to
// THAT board, or the route answers 404 (not 403: no existence oracle):
//   - POST  /api/board/[id]/cards     stackId ∈ deck(params.id).stacks
//   - PATCH /api/board/[id]/cards     stackId ∈ deck.stacks AND cardId ∈ deck.cards
//   - POST  /api/board/[id]/promote   the action item's protocol committee_id ===
//                                     board.org_unit_id (the /promotable predicate)
// A member of unit X uses X's board id (which passes the scope gate) to reach
// unit Y's stack, card or action item: every such request is a 404, and the
// port's write is never called.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BoardBackendPort, Board, Card, Deck, Stack } from '$lib/server/board/backend/port'

const { mockResolveBackend, mockGetActionItem, mockGetProtocol } = vi.hoisted(() => ({
  mockResolveBackend: vi.fn(),
  mockGetActionItem: vi.fn(),
  mockGetProtocol: vi.fn(),
}))

vi.mock('$lib/server/board/scope', () => ({ resolveBoardOrgUnitScope: vi.fn(async () => ['ou-x']) }))
vi.mock('$lib/server/board/backend/resolve', () => ({ resolveBoardBackendOr503: mockResolveBackend }))
vi.mock('$lib/server/protocols/protocol-db', () => ({ getActionItem: mockGetActionItem, getProtocol: mockGetProtocol }))

import { POST as createCard, PATCH as moveCard } from './[id]/cards/+server'
import { POST as promote } from './[id]/promote/+server'

const member = { auth: async () => ({ user: { id: 'u1', roles: ['member'] } }) } as any

const board = (id: string, ou: string): Board => ({ id, org_unit_id: ou, name: id, archived: false, created_at: new Date() })
const stack = (id: string, boardId: string, order: number): Stack => ({ id, board_id: boardId, name: id, sort_order: order })
const card = (id: string, stackId: string): Card =>
  ({ id, stack_id: stackId, title: id, description: null, assignee_keycloak_id: null, due_date: null, label: null, sort_order: 0, protocol_action_item_id: null, created_by: 'u1', created_at: new Date() })

// Unit X (the user's) and unit Y (not the user's), one board each, in ONE tenant.
const DECKS: Record<string, Deck> = {
  'b-x': { board: board('b-x', 'ou-x'), stacks: [stack('s-x1', 'b-x', 0), stack('s-x2', 'b-x', 1)], cards: [card('c-x1', 's-x1')] },
  'b-y': { board: board('b-y', 'ou-y'), stacks: [stack('s-y1', 'b-y', 0)], cards: [card('c-y1', 's-y1')] },
}

let port: BoardBackendPort & { createCard: ReturnType<typeof vi.fn>; moveCard: ReturnType<typeof vi.fn>; promoteActionItem: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.clearAllMocks()
  port = {
    kind: 'service',
    getBoard: vi.fn(async (id: string) => DECKS[id]?.board ?? null),
    deckFor: vi.fn(async (id: string) => {
      const d = DECKS[id]
      if (!d) throw new Error('board not found')
      return d
    }),
    createCard: vi.fn(async (d: { stackId: string; title: string }) => card('c-new', d.stackId)),
    moveCard: vi.fn(async (id: string, to: { stackId: string }) => card(id, to.stackId)),
    promoteActionItem: vi.fn(async () => card('c-promoted', 's-x1')),
    listBoardsForOrgUnits: vi.fn(),
    listPromotedActionItemIds: vi.fn(),
    createBoard: vi.fn(),
    createStack: vi.fn(),
  } as never
  mockResolveBackend.mockReturnValue(port)
  mockGetActionItem.mockImplementation(async (id: string) =>
    ({ 'ai-x': { id: 'ai-x', protocol_id: 'p-x', text: 'X', assignee_keycloak_id: null, due_date: null }, 'ai-y': { id: 'ai-y', protocol_id: 'p-y', text: 'Y', assignee_keycloak_id: null, due_date: null } })[id] ?? null,
  )
  mockGetProtocol.mockImplementation(async (id: string) => ({ 'p-x': { id: 'p-x', committee_id: 'ou-x' }, 'p-y': { id: 'p-y', committee_id: 'ou-y' } })[id] ?? null)
})

function req(method: string, body: unknown): Request {
  return new Request('http://x', { method, body: JSON.stringify(body) })
}

describe('POST /api/board/[id]/cards — stackId must be a stack of params.id (B12)', () => {
  it("404 for unit Y's stack through unit X's board; nothing written", async () => {
    await expect(createCard({ params: { id: 'b-x' }, request: req('POST', { stackId: 's-y1', title: 'intrusion' }), locals: member } as any)).rejects.toMatchObject({ status: 404 })
    expect(port.createCard).not.toHaveBeenCalled()
  })

  it('201 for a stack of the board itself (happy path unchanged)', async () => {
    const res = await createCard({ params: { id: 'b-x' }, request: req('POST', { stackId: 's-x2', title: 'ok' }), locals: member } as any)
    expect(res.status).toBe(201)
    expect(port.createCard).toHaveBeenCalledWith(expect.objectContaining({ stackId: 's-x2', createdBy: 'u1' }))
  })
})

describe('PATCH /api/board/[id]/cards — cardId and stackId must belong to params.id (B12)', () => {
  it("404 moving the board's own card into unit Y's stack", async () => {
    await expect(moveCard({ params: { id: 'b-x' }, request: req('PATCH', { cardId: 'c-x1', stackId: 's-y1', order: 0 }), locals: member } as any)).rejects.toMatchObject({ status: 404 })
    expect(port.moveCard).not.toHaveBeenCalled()
  })

  it("404 moving unit Y's card through unit X's board, even into X's own stack", async () => {
    await expect(moveCard({ params: { id: 'b-x' }, request: req('PATCH', { cardId: 'c-y1', stackId: 's-x2', order: 0 }), locals: member } as any)).rejects.toMatchObject({ status: 404 })
    expect(port.moveCard).not.toHaveBeenCalled()
  })

  it('200 moving a card of the board within the board (happy path unchanged)', async () => {
    const res = await moveCard({ params: { id: 'b-x' }, request: req('PATCH', { cardId: 'c-x1', stackId: 's-x2', order: 1 }), locals: member } as any)
    expect(res.status).toBe(200)
    expect(port.moveCard).toHaveBeenCalledWith('c-x1', { stackId: 's-x2', order: 1 })
  })
})

describe('POST /api/board/[id]/promote — the action item must be of the board\'s committee (B12)', () => {
  it("404 promoting unit Y's action item through unit X's board; nothing written", async () => {
    await expect(promote({ params: { id: 'b-x' }, request: req('POST', { actionItemId: 'ai-y' }), locals: member } as any)).rejects.toMatchObject({ status: 404 })
    expect(port.promoteActionItem).not.toHaveBeenCalled()
  })

  it('404 (not 403) for an unknown action item too — no existence oracle', async () => {
    await expect(promote({ params: { id: 'b-x' }, request: req('POST', { actionItemId: 'ai-missing' }), locals: member } as any)).rejects.toMatchObject({ status: 404 })
    expect(port.promoteActionItem).not.toHaveBeenCalled()
  })

  it("201 promoting the committee's own action item (happy path unchanged)", async () => {
    const res = await promote({ params: { id: 'b-x' }, request: req('POST', { actionItemId: 'ai-x' }), locals: member } as any)
    expect(res.status).toBe(201)
    expect(port.promoteActionItem).toHaveBeenCalledWith('b-x', { id: 'ai-x', text: 'X', assigneeKeycloakId: null, dueDate: null }, 'u1')
  })
})
