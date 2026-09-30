// modules/board/test/isolation/api.ts
//
// The board's API as the isolation case sees it (R29-BOARD-STORE-K §3.4): one
// method per leaf route, each called AS a tenant, each answering {status, body}.
// The transport is injected: leaf-api.ts talks to the leaf over the internal
// headers; a later adapter (TASK-044 / TASK-152) talks to the kernel's
// /api/board/* over a real session, and the same case runs over it.
import type { TenantRef } from '../../src/store/index.ts'

export interface ApiResult {
  status: number
  body: unknown
}

export interface CreateBoardInput {
  orgUnitId: string
  name: string
  archived?: boolean
  stacks?: string[]
}

export interface CreateCardInput {
  stackId: string
  title: string
  createdBy?: string | null
  description?: string | null
  order?: number
  protocolActionItemId?: string | null
}

export interface PromoteInput {
  item: { id: string; text: string; assigneeKeycloakId: string | null; dueDate: string | null }
  createdBy: string
}

export interface BoardApi {
  /** GET /api/v1/boards?orgUnitId=… */
  listBoards(as: TenantRef, orgUnitIds: readonly string[]): Promise<ApiResult>
  /** GET /api/v1/boards/:id */
  getBoard(as: TenantRef, boardId: string): Promise<ApiResult>
  /** GET /api/v1/boards/:id/deck */
  deck(as: TenantRef, boardId: string): Promise<ApiResult>
  /** POST /api/v1/boards */
  createBoard(as: TenantRef, input: CreateBoardInput): Promise<ApiResult>
  /** POST /api/v1/boards/:id/stacks */
  createStack(as: TenantRef, boardId: string, input: { name: string; order: number }): Promise<ApiResult>
  /** POST /api/v1/cards */
  createCard(as: TenantRef, input: CreateCardInput): Promise<ApiResult>
  /** PATCH /api/v1/cards/:id/move */
  moveCard(as: TenantRef, cardId: string, to: { stackId: string; order: number }): Promise<ApiResult>
  /** POST /api/v1/boards/:id/promote */
  promote(as: TenantRef, boardId: string, input: PromoteInput): Promise<ApiResult>
  /** POST /api/v1/cards/promoted */
  promoted(as: TenantRef, candidateIds: readonly string[]): Promise<ApiResult>
}
