// gremion-ui/src/lib/server/board/backend/port.ts
// T1 — branch-by-abstraction seam for the Deck board subsystem.
//
// BoardBackendPort is the interface every consumer of the board subsystem calls
// once the seam is wired in (the five /api/board routes + the /tasks page load).
// The method set is exactly the boardDb surface those callers actually invoke:
// listBoardsForOrgUnits / getBoard / deckFor / createCard / moveCard /
// promoteActionItem / listPromotedActionItemIds.
//
// The domain DTO types (Board, Stack, Card + the input shapes) are lifted
// verbatim from board-db.ts. After the (HELD) cutover, callers import only from
// this seam; board-db.ts remains the in-process implementation that
// InprocessBoardClient delegates to.
//
// This file has NO runtime dependencies — it is a pure TypeScript interface.
// DO NOT import from any server module here.

// ── Domain transfer types (lifted verbatim from board-db.ts) ─────────────────

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

export interface CreateCardInput {
  stackId: string
  title: string
  description?: string | null
  assigneeKeycloakId?: string | null
  dueDate?: string | null
  label?: string | null
  order?: number
  protocolActionItemId?: string | null
  createdBy?: string | null
}

export interface MoveCardTarget {
  stackId: string
  order: number
}

/** The already-resolved protocol action item promoted into a card. The route
 *  resolves it from the kernel-owned protocol-db BEFORE calling the port, so
 *  this seam carries only board-owned data (no cross-DB read in the leaf). */
export interface PromoteActionItemInput {
  id: string
  text: string
  assigneeKeycloakId: string | null
  dueDate: string | null
}

export interface Deck {
  board: Board
  stacks: readonly Stack[]
  cards: readonly Card[]
}

// ── Port interface ────────────────────────────────────────────────────────────

export interface BoardBackendPort {
  /**
   * Discriminant identifying which implementation is in use.
   * 'inprocess' = in-process boardDb calls (byte-identical to the monolith);
   * 'service' = HTTP calls to the board leaf service.
   */
  readonly kind: 'inprocess' | 'service'

  /** Boards for the given org-unit scope. Empty scope → []. */
  listBoardsForOrgUnits(orgUnitIds: readonly string[]): Promise<readonly Board[]>
  /** One board by id, or null when it does not exist. */
  getBoard(id: string): Promise<Board | null>
  /** Board + its stacks + cards. THROWS when the board does not exist. */
  deckFor(boardId: string): Promise<Deck>
  /** Create a card in a stack. */
  createCard(data: CreateCardInput): Promise<Card>
  /** Move/reorder a card (its stack IS its status). null when the card is gone. */
  moveCard(id: string, to: MoveCardTarget): Promise<Card | null>
  /** Promote a resolved action item into the board's first stack (idempotent).
   *  THROWS when the board has no stacks. */
  promoteActionItem(boardId: string, item: PromoteActionItemInput, createdBy: string): Promise<Card>
  /** The subset of the given protocol-action-item ids that ALREADY have a card
   *  (i.e. were promoted) — the board-owned half of the /promotable filter (#384).
   *  The route resolves the OPEN action items from the kernel-owned protocol
   *  tables BEFORE calling this, so the seam carries only board-owned data (the
   *  card table lives in the leaf DB under BOARD_BACKEND=service). Any card
   *  counts — the check is deliberately NOT board-scoped, mirroring the global
   *  partial unique index on card.protocol_action_item_id. Empty input → []. */
  listPromotedActionItemIds(candidateIds: readonly string[]): Promise<readonly string[]>
}
