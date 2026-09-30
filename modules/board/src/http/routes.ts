// modules/board/src/http/routes.ts
//
// All /api/v1/* route handlers for the board leaf service. Every route runs
// under the guard (shared secret + UUIDv7 tenant id + slug) and on the calling
// tenant's OWN database (storeFn → t_<hex32>__board, or a tenant-level refusal).
// The route set is the BoardBackendPort surface the kernel's board port calls:
//   GET   /api/v1/boards?orgUnitId=…   → { data: Board[] }   (listBoardsForOrgUnits)
//   POST  /api/v1/boards               → { board, stacks } (201) (createBoardWithStacks, R29-BOARD-STORE-K)
//   GET   /api/v1/boards/:id           → Board | 404         (getBoard)
//   GET   /api/v1/boards/:id/deck      → { board,stacks,cards } | 404 (deckFor)
//   POST  /api/v1/boards/:id/stacks    → Stack (201) | 404   (createStack, R29-BOARD-STORE-K)
//   POST  /api/v1/cards                → Card (201) | 404    (createCard)
//   PATCH /api/v1/cards/:id/move       → Card | 404          (moveCard)
//   POST  /api/v1/cards/promoted       → { data: string[] } (listPromotedActionItemIds, #384)
//         body: { candidateIds: string[] } — a POST body (not repeated GET query
//         params) so the candidate id list can exceed node:http's ~16KB header
//         cap (~320 ids per committee); #387.
//   POST  /api/v1/boards/:id/promote   → Card (201) | 404 | 409 (promoteActionItem)
//
// Entity-returning routes return the entity DIRECTLY (no {data} envelope) —
// matching ServiceBoardClient's deserialize helpers, which read fields straight
// off the body. List routes wrap in { data: [...] }.
//
// Error envelope: { success:false, error } — the house JSON shape. A tenant-level
// refusal answers { success:false, error: <code> } with cache-control: no-store.
//
// Error mapping (R29-BOARD-STORE-K §3.2), in wrap():
//   refusal from storeFn                → its status + code (404 / 503 + Retry-After)
//   SQLSTATE 3D000 at QUERY time        → 404 tenant_not_provisioned (the database was
//                                         dropped under a cached gate verdict — disable)
//   57P01/57P02/57P03, a lost connection → re-classify the tenant: 404 when its database
//                                         is gone, else 503 tenant_unavailable
//   23503 on card→stack / stack→board   → 404 stack not found / board not found
//   22P02 (a malformed id)              → the route's own 404 (stack / board not found)
//   22021 (text Postgres refuses)       → 400 invalid text
// Anything else is a 500 and is logged.

import type http from 'node:http'
import { z } from 'zod'
import type { Sql, TenantRef } from '../store/index.js'
import { CONNECTION_LOST, isRefusal, NOT_PROVISIONED, sqlState, unavailable, type Refusal } from '../store/tenant-db.js'
import type { Route, RouteContext } from './router.js'
import {
  listBoardsForOrgUnits,
  getBoard,
  deckFor,
  createBoardWithStacks,
  createStack,
  createCard,
  moveCard,
  stackExists,
  promoteActionItem,
  listPromotedActionItemIds,
} from '../store/index.js'

export interface ApiContext extends RouteContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  tenant: TenantRef
}

export type ApiHandler = (ctx: ApiContext) => Promise<void>

/**
 * Per-tenant store accessor: the tenant's (tenant, board) pool, or a
 * tenant-level refusal (404 tenant_not_provisioned, 503 schema_not_current /
 * tenant_unavailable). buildApp (src/app.ts) supplies it.
 */
export type StoreFn = (tenant: TenantRef) => Promise<Sql | Refusal>

/** Thrown by a handler to answer a tenant-level refusal (caught by wrap()). */
class RefusedError extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.code)
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders })
  res.end(JSON.stringify(body))
}

function sendError(res: http.ServerResponse, status: number, error: string): void {
  sendJson(res, status, { success: false, error })
}

/** A refusal is about the tenant, not the resource: never cached by anyone downstream. */
function sendRefusal(res: http.ServerResponse, refusal: Refusal): void {
  sendJson(
    res,
    refusal.status,
    { success: false, error: refusal.code },
    { 'cache-control': 'no-store', ...(refusal.retryAfter !== undefined ? { 'retry-after': String(refusal.retryAfter) } : {}) },
  )
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

/** A row id as Postgres' uuid type accepts it in canonical form (any version: rows use gen_random_uuid). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
    id: z.string().regex(UUID, 'item.id must be a uuid'),
    text: z.string().min(1),
    assigneeKeycloakId: z.string().nullable(),
    dueDate: z.string().nullable(),
  }),
  createdBy: z.string().min(1),
})

const PromotedIdsSchema = z.object({
  candidateIds: z.array(z.string().regex(UUID, 'candidateIds must be uuids')),
})

// R29-BOARD-STORE-K A5 / Q10 input caps: name 1..120, stack name 1..60, at most 20 stacks.
const CreateBoardSchema = z.object({
  orgUnitId: z.string().regex(UUID, 'orgUnitId must be a uuid'),
  name: z.string().min(1).max(120),
  archived: z.boolean().optional(),
  stacks: z.array(z.string().min(1).max(60)).max(20).optional(),
})

const CreateStackSchema = z.object({
  name: z.string().min(1).max(60),
  order: z.number().int().min(0),
})

/** The FK constraints of migrations/001_init.sql → what the caller named that is not there. */
const FK_NOT_FOUND: Readonly<Record<string, string>> = {
  card_stack_id_fkey: 'stack not found',
  stack_board_id_fkey: 'board not found',
}

// ── route builder ─────────────────────────────────────────────────────────────

export function buildApiRoutes(store: StoreFn): Route[] {
  /** The tenant's pool, or a RefusedError that wrap() answers. */
  const storeFn = async (tenant: TenantRef): Promise<Sql> => {
    const r = await store(tenant)
    if (isRefusal(r)) throw new RefusedError(r)
    return r
  }

  /** After a lost connection: is the tenant's database gone (404) or just unreachable (503)? */
  const reclassify = async (tenant: TenantRef): Promise<Refusal> => {
    try {
      const r = await store(tenant)
      if (isRefusal(r)) return r
      await r`SELECT 1`
      return unavailable()
    } catch (err) {
      return sqlState(err) === '3D000' ? NOT_PROVISIONED : unavailable()
    }
  }

  /**
   * @param badRef the route's 404 for a reference that is malformed (22P02) or
   *   names a row this tenant's database does not have (23503 with no mapped constraint).
   */
  const wrap =
    (handler: ApiHandler, badRef?: string): Route['handler'] =>
    async (ctx) => {
      const extended = ctx as unknown as ApiContext
      try {
        await handler(extended)
      } catch (err) {
        const code = sqlState(err)
        if (err instanceof RefusedError) {
          sendRefusal(extended.res, err.refusal)
        } else if (err instanceof z.ZodError) {
          sendError(extended.res, 400, err.issues.map((e) => e.message).join('; '))
        } else if (err instanceof SyntaxError || (err instanceof Error && err.message === 'invalid JSON body')) {
          sendError(extended.res, 400, 'invalid JSON body')
        } else if (err instanceof Error && err.message === 'board not found') {
          sendError(extended.res, 404, err.message)
        } else if (err instanceof Error && err.message === 'board has no stacks') {
          sendError(extended.res, 409, err.message)
        } else if (code === '3D000') {
          sendRefusal(extended.res, NOT_PROVISIONED)
        } else if (code !== undefined && CONNECTION_LOST.has(code)) {
          sendRefusal(extended.res, await reclassify(extended.tenant))
        } else if (code === '23503' && (FK_NOT_FOUND[(err as { constraint_name?: string }).constraint_name ?? ''] ?? badRef)) {
          sendError(extended.res, 404, FK_NOT_FOUND[(err as { constraint_name?: string }).constraint_name ?? ''] ?? badRef!)
        } else if (code === '22P02' && badRef) {
          sendError(extended.res, 404, badRef)
        } else if (code === '22021') {
          // text Postgres refuses to store (e.g. a NUL byte): the caller's input
          sendError(extended.res, 400, 'invalid text')
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
        if (!orgUnitIds.every((id) => UUID.test(id))) return sendError(res, 400, 'orgUnitId must be a uuid')
        const sql = await storeFn(tenant)
        const boards = await listBoardsForOrgUnits(sql, orgUnitIds)
        sendJson(res, 200, { data: boards })
      }),
    },

    // ── POST /api/v1/boards (R29-BOARD-STORE-K A5) ─────────────────────────────
    // A board and its stacks in one transaction → 201 { board, stacks }.
    {
      method: 'POST',
      path: '/api/v1/boards',
      handler: wrap(async ({ req, res, tenant }) => {
        const body = CreateBoardSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const created = await createBoardWithStacks(sql, body)
        sendJson(res, 201, created)
      }),
    },

    // ── POST /api/v1/boards/:id/stacks (R29-BOARD-STORE-K A5) ──────────────────
    // → 201 Stack; 404 'board not found' unless the board is in THIS tenant.
    {
      method: 'POST',
      path: '/api/v1/boards/:id/stacks',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const body = CreateStackSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const boardId = params['id']!
        if (!UUID.test(boardId) || !(await getBoard(sql, boardId))) return sendError(res, 404, 'board not found')
        const stack = await createStack(sql, { boardId, name: body.name, order: body.order })
        sendJson(res, 201, stack)
      }, 'board not found'),
    },

    // ── GET /api/v1/boards/:id ───────────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/boards/:id',
      handler: wrap(async ({ res, params, tenant }) => {
        const sql = await storeFn(tenant)
        const id = params['id']!
        const board = UUID.test(id) ? await getBoard(sql, id) : null
        if (!board) return sendError(res, 404, 'not found')
        sendJson(res, 200, board)
      }, 'not found'),
    },

    // ── GET /api/v1/boards/:id/deck ──────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/v1/boards/:id/deck',
      handler: wrap(async ({ res, params, tenant }) => {
        const sql = await storeFn(tenant)
        const id = params['id']!
        if (!UUID.test(id)) return sendError(res, 404, 'board not found')
        // deckFor THROWS 'board not found' → the wrap() maps it to 404.
        const deck = await deckFor(sql, id)
        sendJson(res, 200, deck)
      }, 'board not found'),
    },

    // ── POST /api/v1/cards ───────────────────────────────────────────────────
    // A stackId this tenant's database does not have is refused by the FK
    // (23503) or, when it is not a uuid, by the uuid type (22P02): both 404.
    {
      method: 'POST',
      path: '/api/v1/cards',
      handler: wrap(async ({ req, res, tenant }) => {
        const body = CreateCardSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const card = await createCard(sql, body)
        sendJson(res, 201, card)
      }, 'stack not found'),
    },

    // ── PATCH /api/v1/cards/:id/move ─────────────────────────────────────────
    // The target stack must exist in THIS tenant's database: checked explicitly
    // on the same pool, so the refusal is a 404, not an FK accident.
    {
      method: 'PATCH',
      path: '/api/v1/cards/:id/move',
      handler: wrap(async ({ req, res, params, tenant }) => {
        const body = MoveCardSchema.parse(await readBody(req))
        const sql = await storeFn(tenant)
        const cardId = params['id']!
        if (!UUID.test(cardId)) return sendError(res, 404, 'not found')
        if (!(await stackExists(sql, body.stackId))) return sendError(res, 404, 'stack not found')
        const card = await moveCard(sql, cardId, { stackId: body.stackId, order: body.order })
        if (!card) return sendError(res, 404, 'not found')
        sendJson(res, 200, card)
      }, 'stack not found'),
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
        const boardId = params['id']!
        if (!UUID.test(boardId) || !(await getBoard(sql, boardId))) return sendError(res, 404, 'board not found')
        // promoteActionItem THROWS 'board has no stacks' → wrap() maps it to 409.
        const card = await promoteActionItem(sql, boardId, body.item, body.createdBy)
        sendJson(res, 201, card)
      }, 'board not found'),
    },
  ]
}
