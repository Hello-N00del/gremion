// gremion-ui/src/lib/server/board/backend/inprocess-client.ts
// branch-by-abstraction default path; byte-identical to current behaviour until
// the deliberate (held) cutover to 'service'.
//
// Every method is a thin async delegate to the corresponding boardDb export.
// No logic lives here — callers use BoardBackendPort, not this class directly.
// It delegates to the SAME `boardDb` object the routes previously imported, so
// the pre-existing board route/db tests (which vi.mock '$lib/server/board/board-db')
// keep passing UNCHANGED through this seam.

import type {
  BoardBackendPort,
  Board,
  Card,
  CreateCardInput,
  MoveCardTarget,
  PromoteActionItemInput,
  Deck,
  CreateBoardInput,
  CreatedBoard,
  CreateStackInput,
  Stack,
} from './port'
import { boardDb } from '../board-db'

export class InprocessBoardClient implements BoardBackendPort {
  readonly kind = 'inprocess' as const

  async listBoardsForOrgUnits(orgUnitIds: readonly string[]): Promise<readonly Board[]> {
    return boardDb.listBoardsForOrgUnits(orgUnitIds)
  }

  async getBoard(id: string): Promise<Board | null> {
    return boardDb.getBoard(id)
  }

  async deckFor(boardId: string): Promise<Deck> {
    return boardDb.deckFor(boardId)
  }

  async createCard(data: CreateCardInput): Promise<Card> {
    return boardDb.createCard(data)
  }

  async moveCard(id: string, to: MoveCardTarget): Promise<Card | null> {
    return boardDb.moveCard(id, to)
  }

  async promoteActionItem(
    boardId: string,
    item: PromoteActionItemInput,
    createdBy: string,
  ): Promise<Card> {
    return boardDb.promoteActionItem(boardId, item, createdBy)
  }

  async listPromotedActionItemIds(candidateIds: readonly string[]): Promise<readonly string[]> {
    return boardDb.listPromotedActionItemIds(candidateIds)
  }

  async createBoard(input: CreateBoardInput): Promise<CreatedBoard> {
    return boardDb.createBoardWithStacks(input)
  }

  async createStack(boardId: string, input: CreateStackInput): Promise<Stack> {
    return boardDb.createStack({ boardId, name: input.name, order: input.order })
  }
}
