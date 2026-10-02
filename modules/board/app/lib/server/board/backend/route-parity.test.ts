// gremion-ui/src/lib/server/board/backend/route-parity.test.ts
// T1 — byte-identical delegation guard for the default (inprocess) path.
//
// Every consumer of the board subsystem now calls the BoardBackendPort via
// getBoardBackend(). With BOARD_BACKEND unset the port IS InprocessBoardClient,
// which must delegate to the SAME boardDb the routes previously imported
// directly — argument-for-argument, result passed straight through — so the
// four pre-existing board route/db tests stay green UNMODIFIED (the proof of
// byte-identical behaviour). deckFor / promoteActionItem THROW on not-found /
// no-stacks in boardDb; the port must propagate those throws unchanged (the
// [id] deck route + promote route rely on the throw reaching SvelteKit).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockCreateBoard,
  mockListBoardsForOrgUnits,
  mockGetBoard,
  mockCreateStack,
  mockCreateCard,
  mockMoveCard,
  mockUpdateCard,
  mockDeckFor,
  mockPromoteActionItem,
  mockListPromotedActionItemIds,
} = vi.hoisted(() => ({
  mockCreateBoard: vi.fn(),
  mockListBoardsForOrgUnits: vi.fn(),
  mockGetBoard: vi.fn(),
  mockCreateStack: vi.fn(),
  mockCreateCard: vi.fn(),
  mockMoveCard: vi.fn(),
  mockUpdateCard: vi.fn(),
  mockDeckFor: vi.fn(),
  mockPromoteActionItem: vi.fn(),
  mockListPromotedActionItemIds: vi.fn(),
}))

vi.mock('../board-db', () => ({
  boardDb: {
    createBoard: mockCreateBoard,
    listBoardsForOrgUnits: mockListBoardsForOrgUnits,
    getBoard: mockGetBoard,
    createStack: mockCreateStack,
    createCard: mockCreateCard,
    moveCard: mockMoveCard,
    updateCard: mockUpdateCard,
    deckFor: mockDeckFor,
    promoteActionItem: mockPromoteActionItem,
    listPromotedActionItemIds: mockListPromotedActionItemIds,
  },
}))

import { InprocessBoardClient } from './inprocess-client'

const BOARD = { id: 'b1', org_unit_id: 'ou-1', name: 'StuRa', archived: false, created_at: new Date() }
const CARD = {
  id: 'c1', stack_id: 's1', title: 'Neu', description: null, assignee_keycloak_id: null,
  due_date: null, label: null, sort_order: 0, protocol_action_item_id: null, created_by: 'u1', created_at: new Date(),
}

describe('InprocessBoardClient — byte-identical delegation to boardDb', () => {
  let client: InprocessBoardClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new InprocessBoardClient()
  })

  it('has kind === inprocess', () => {
    expect(client.kind).toBe('inprocess')
  })

  it('listBoardsForOrgUnits delegates and passes the result through', async () => {
    mockListBoardsForOrgUnits.mockResolvedValueOnce([BOARD])
    const result = await client.listBoardsForOrgUnits(['ou-1'])
    expect(mockListBoardsForOrgUnits).toHaveBeenCalledWith(['ou-1'])
    expect(result).toEqual([BOARD])
  })

  it('getBoard delegates and returns null when boardDb returns null', async () => {
    mockGetBoard.mockResolvedValueOnce(null)
    const result = await client.getBoard('missing')
    expect(mockGetBoard).toHaveBeenCalledWith('missing')
    expect(result).toBeNull()
  })

  it('getBoard passes the board through when found', async () => {
    mockGetBoard.mockResolvedValueOnce(BOARD)
    const result = await client.getBoard('b1')
    expect(result).toBe(BOARD)
  })

  it('deckFor delegates and passes the deck through', async () => {
    const deck = { board: BOARD, stacks: [], cards: [] }
    mockDeckFor.mockResolvedValueOnce(deck)
    const result = await client.deckFor('b1')
    expect(mockDeckFor).toHaveBeenCalledWith('b1')
    expect(result).toBe(deck)
  })

  it('deckFor PROPAGATES a boardDb throw (board not found) unchanged', async () => {
    mockDeckFor.mockRejectedValueOnce(new Error('board not found'))
    await expect(client.deckFor('missing')).rejects.toThrow('board not found')
  })

  it('createCard delegates with the exact input and returns the created card', async () => {
    const input = { stackId: 's1', title: 'Neu', createdBy: 'u1' }
    mockCreateCard.mockResolvedValueOnce(CARD)
    const result = await client.createCard(input)
    expect(mockCreateCard).toHaveBeenCalledWith(input)
    expect(result).toBe(CARD)
  })

  it('moveCard delegates and returns null when boardDb returns null', async () => {
    mockMoveCard.mockResolvedValueOnce(null)
    const result = await client.moveCard('c1', { stackId: 's2', order: 0 })
    expect(mockMoveCard).toHaveBeenCalledWith('c1', { stackId: 's2', order: 0 })
    expect(result).toBeNull()
  })

  it('promoteActionItem delegates argument-for-argument and returns the card', async () => {
    const item = { id: 'ai-1', text: 'Do it', assigneeKeycloakId: null, dueDate: null }
    mockPromoteActionItem.mockResolvedValueOnce(CARD)
    const result = await client.promoteActionItem('b1', item, 'u1')
    expect(mockPromoteActionItem).toHaveBeenCalledWith('b1', item, 'u1')
    expect(result).toBe(CARD)
  })

  it('promoteActionItem PROPAGATES a boardDb throw (board has no stacks) unchanged', async () => {
    const item = { id: 'ai-1', text: 'Do it', assigneeKeycloakId: null, dueDate: null }
    mockPromoteActionItem.mockRejectedValueOnce(new Error('board has no stacks'))
    await expect(client.promoteActionItem('b1', item, 'u1')).rejects.toThrow('board has no stacks')
  })

  it('listPromotedActionItemIds delegates argument-for-argument and passes the result through (#384)', async () => {
    mockListPromotedActionItemIds.mockResolvedValueOnce(['ai-2'])
    const result = await client.listPromotedActionItemIds(['ai-1', 'ai-2'])
    expect(mockListPromotedActionItemIds).toHaveBeenCalledWith(['ai-1', 'ai-2'])
    expect(result).toEqual(['ai-2'])
  })
})
