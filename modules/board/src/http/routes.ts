// services/board/src/http/routes.ts
//
// All /api/v1/* route handlers for the board leaf service. Every route runs
// under the guard (shared secret + tenant headers). The route set is exactly the
// BoardBackendPort surface the kernel's ServiceBoardClient calls:
//   GET   /api/v1/boards?orgUnitId=…   → { data: Board[] }   (listBoardsForOrgUnits)
//   GET   /api/v1/boards/:id           → Board | 404         (getBoard)
//   GET   /api/v1/boards/:id/deck      → { board,stacks,cards } | 404 (deckFor)
//   POST  /api/v1/cards                → Card (201)          (createCard)
//   PATCH /api/v1/cards/:id/move       → Card | 404          (moveCard)
//   POST  /api/v1/cards/promoted       → { data: string[] } (listPromotedActionItemIds, #384)
//         body: { candidateIds: string[] } — a POST body (not repeated GET query
//         params) so the candidate id list can exceed node:http's ~16KB header
//         cap (~320 ids per committee); #387.
//   POST  /api/v1/boards/:id/promote   → Card (201)          (promoteActionItem)
//
// Entity-returning routes return the entity DIRECTLY (no {data} envelope) —
// matching ServiceBoardClient's deserialize helpers, which read fields straight
// off the body. List routes wrap in { data: [...] }.
//
// Error envelope: { success:false, error } — the house JSON shape.

import type http from 'node:http'
import { z } from 'zod'
import type { Sql, TenantRef } from '../store/index.js'
import type { Route, RouteContext } from './router.js'
import {
  listBoardsForOrgUnits,
  getBoard,
  deckFor,
  createCard,
  moveCard,
  promoteActionItem,
  listPromotedActionItemIds,
} from '../store/index.js'

export interface ApiContext extends RouteContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  tenant: TenantRef
}

export type ApiHandler = (ctx: ApiContext) => Promise<void>

/** Per-tenant store accessor (injected so tests can supply a pre-seeded pool). */
export type StoreFn = (tenant: TenantRef) => Promise<Sql>

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders })
  res.end(JSON.stringify(body))
}

function sendError(res: http.ServerResponse, status: number, error: string): void {
  sendJson(res, status, { success: false, error })
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const CreateCardSchema = z.object({
  stackId: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().nullable().optional(),
  assigneeKeycloakId: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  order: z.number().int().min(0).optional(),
  protocolActionItemId: z.string().nullable().optional(),
  createdBy: z.string().nullable().optional(),
})

const MoveCardSchema = z.object({
  stackId: z.string().min(1),
  order: z.number().int().min(0),
})

const PromoteSchema = z.object({
  item: z.object({
    id: z.string().min(1),
    text: z.string().min(1),
    assigneeKeycloakId: z.string().nullable(),
    dueDate: z.string().nullable(),
  }),
  createdBy: z.string().min(1),
})

const PromotedIdsSchema = z.object({
  candidateIds: z.array(z.string().min(1)),
})

// ── route builder ─────────────────────────────────────────────────────────────

export function buildApiRoutes(storeFn: StoreFn): Route[] {
  const wrap =
    (handler: ApiHandler): Route['handler'] =>
    async (ctx) => {
      const extended = ctx as unknown as ApiContext
      try {
        await handler(extended)
      } catch (err) {
        if (err instanceof z.ZodError) {
          sendError(extended.res, 400, err.issues.map((e) => e.message).join('; '))
        } else if (err instanceof SyntaxError || (err instanceof Error && err.message === 'invalid JSON body')) {
          sendError(extended.res, 400, 'invalid JSON body')
        } else if (err instanceof Error && err.message === 'board not found') {
          sendError(extended.res, 404, err.message)
        } else if (err instanceof Error && err.message === 'board has no stacks') {
          sendError(extended.res, 409, err.message)
        } else {
          console.error('[board:api] unhandled route error', err)
          if (!extended.res.headersSent) sendError(extended.res, 500, 'internal error')
        }
      }
    }

  return [
    // ── GET /api/v1/boards?orgUnitId=… ───────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/boards',
      handler: wrap(async ({ req, res, tenant }) => {
        const url = new URL(req.url ?? '/', 'http://internal')
        const orgUnitIds = url.searchParams.getAll('orgUnitId')
        const sql = await storeFn(tenant)
        const boards = await listBoardsForOrgUnits(sql, orgUnitIds)
        sendJson(res, 200, { data: boards })
      }),
    },

    // ── GET /api/v1/boards/:id ───────────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/boards/:id',
      handler: wrap(async ({ res, params, tenant }) => {
        const sql = await storeFn(tenant)
        const board = await getBoard(sql, params['id']!)
        if (!board) return sendError(res, 404, 'not found')
        sendJson(res, 200, board)
      }),
    },

    // ── GET /api/v1/boards/:id/deck ──────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/boards/:id/deck',
      handler: wrap(async ({ res, params, tenant }) => {
        const sql = await storeFn(tenant)
        // deckFor THROWS 'board not found' → the wrap() maps it to 404.
        const deck = await deckFor(sql, params['id']!)
        sendJson(res, 200, deck)
      }),
    },

    // ── POST /api/v1/cards ───────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/api/v1/cards',
      handler: wrap(async ({ req, res, tenant }) => {
        const body = CreateCardSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const card = await createCard(sql, body)
        sendJson(res, 201, card)
      }),
    },

    // ── PATCH /api/v1/cards/:id/move ─────────────────────────────────────────
    {
      method: 'PATCH',
      path: '/api/v1/cards/:id/move',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const body = MoveCardSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const card = await moveCard(sql, params['id']!, { stackId: body.stackId, order: body.order })
        if (!card) return sendError(res, 404, 'not found')
        sendJson(res, 200, card)
      }),
    },

    // ── POST /api/v1/cards/promoted (#384, #387) ─────────────────────────────
    // Subset of the kernel-supplied action-item ids that already have a card in
    // this leaf's card table (the board-owned half of the /promotable filter).
    // A POST body carries the candidate id list instead of repeated GET query
    // params — the list can exceed node:http's ~16KB request-header cap (~320
    // ids). Static path — no clash with /api/v1/cards/:id/* (only PATCH …/move
    // exists) nor with POST /api/v1/cards (exact-match regex, anchored).
    {
      method: 'POST',
      path: '/api/v1/cards/promoted',
      handler: wrap(async ({ req, res, tenant }) => {
        const { candidateIds } = PromotedIdsSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const ids = await listPromotedActionItemIds(sql, candidateIds)
        sendJson(res, 200, { data: ids })
      }),
    },

    // ── POST /api/v1/boards/:id/promote ──────────────────────────────────────
    {
      method: 'POST',
      path: '/api/v1/boards/:id/promote',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const body = PromoteSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        // promoteActionItem THROWS 'board has no stacks' → wrap() maps it to 409.
        const card = await promoteActionItem(sql, params['id']!, body.item, body.createdBy)
        sendJson(res, 201, card)
      }),
    },
  ]
}
