// modules/board/app/lib/server/board/backend/routed-client.ts
// The router: implements the same port as the two real clients and, inside each method, asks the
// location flag where THIS customer's board lives (location.ts) and delegates.
//
//   kernel → InprocessBoardClient (the kernel tables)
//   moving → InprocessBoardClient for reads; every write is refused with BoardMovingError
//   module → ServiceBoardClient (the board module's own database), reads and writes
//
// The factory stays synchronous (index.ts): the flag is awaited here, per call, never at
// construction, so resolve.ts and the seed keep calling getBoardBackend() unchanged. A flag that
// cannot be read throws BoardLocationUnreadableError from every method; nothing falls back to a
// guess. The routes map both errors to a 503 (resolve.ts).

import type { TracerPort } from '@gremion/ports/tracer'
import { InprocessBoardClient } from './inprocess-client'
import { ServiceBoardClient } from './service-client'
import { BoardMovingError, getBoardLocation } from './location'
import type {
  BoardBackendPort,
  Board,
  Card,
  CreateBoardInput,
  CreateCardInput,
  CreateStackInput,
  CreatedBoard,
  Deck,
  MoveCardTarget,
  PromoteActionItemInput,
  Stack,
  UpdateCardPatch,
} from './port'

/** Methods that only read. They keep working while a move copies the board. */
export const BOARD_READ_METHODS = ['listBoardsForOrgUnits', 'getBoard', 'deckFor', 'listPromotedActionItemIds'] as const
/** Methods that write. They are refused while a move copies the board. A method of the port that
 *  is in neither list fails the classification test, so a new write cannot slip past the freeze. */
export const BOARD_WRITE_METHODS = ['createCard', 'moveCard', 'updateCard', 'deleteCard', 'promoteActionItem', 'createBoard', 'createStack'] as const

export interface RoutedBoardBackendOptions {
  /** Forwarded to the service client as x-correlation-id. */
  correlationId?: string
  /** Forwarded to the service client for board.acl.<op> spans. */
  tracer?: TracerPort
}

export class RoutedBoardBackend implements BoardBackendPort {
  readonly kind = 'routed' as const

  private readonly opts: RoutedBoardBackendOptions
  private inprocess: InprocessBoardClient | undefined
  private service: ServiceBoardClient | undefined

  constructor(opts: RoutedBoardBackendOptions = {}) {
    this.opts = opts
  }

  private inprocessClient(): BoardBackendPort {
    return (this.inprocess ??= new InprocessBoardClient())
  }

  private serviceClient(): BoardBackendPort {
    return (this.service ??= new ServiceBoardClient({ correlationId: this.opts.correlationId, tracer: this.opts.tracer }))
  }

  private async forRead(): Promise<BoardBackendPort> {
    return (await getBoardLocation()) === 'module' ? this.serviceClient() : this.inprocessClient()
  }

  private async forWrite(): Promise<BoardBackendPort> {
    const location = await getBoardLocation()
    if (location === 'moving') throw new BoardMovingError()
    return location === 'module' ? this.serviceClient() : this.inprocessClient()
  }

  async listBoardsForOrgUnits(orgUnitIds: readonly string[]): Promise<readonly Board[]> {
    return (await this.forRead()).listBoardsForOrgUnits(orgUnitIds)
  }

  async getBoard(id: string): Promise<Board | null> {
    return (await this.forRead()).getBoard(id)
  }

  async deckFor(boardId: string): Promise<Deck> {
    return (await this.forRead()).deckFor(boardId)
  }

  async listPromotedActionItemIds(candidateIds: readonly string[]): Promise<readonly string[]> {
    return (await this.forRead()).listPromotedActionItemIds(candidateIds)
  }

  async createCard(data: CreateCardInput): Promise<Card> {
    return (await this.forWrite()).createCard(data)
  }

  async moveCard(id: string, to: MoveCardTarget): Promise<Card | null> {
    return (await this.forWrite()).moveCard(id, to)
  }

  async updateCard(id: string, patch: UpdateCardPatch): Promise<Card | null> {
    return (await this.forWrite()).updateCard(id, patch)
  }

  async deleteCard(id: string): Promise<boolean> {
    return (await this.forWrite()).deleteCard(id)
  }

  async promoteActionItem(boardId: string, item: PromoteActionItemInput, createdBy: string): Promise<Card> {
    return (await this.forWrite()).promoteActionItem(boardId, item, createdBy)
  }

  async createBoard(input: CreateBoardInput): Promise<CreatedBoard> {
    return (await this.forWrite()).createBoard(input)
  }

  async createStack(boardId: string, input: CreateStackInput): Promise<Stack> {
    return (await this.forWrite()).createStack(boardId, input)
  }
}
