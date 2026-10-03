// @vitest-environment node
// gremion-ui/src/lib/server/board/backend/service-client.test.ts
// T1 — TDD suite for ServiceBoardClient (HTTP ACL to the board leaf).
//
// Runs in the `node` environment (not the suite-default jsdom): this is a pure
// server-side client driving a real node:http stub via native undici fetch.
// Under jsdom the installed AbortController is a different realm than the one
// undici closed over → "Expected signal to be an instance of AbortSignal". The
// node env keeps the native fetch/AbortSignal pair intact (matching the calendar
// / newsletter service-client specs' same pragma).
//
// Strategy: spin up a node:http stub per suite; point BOARD_SERVICE_URL at it;
// assert header forwarding, error mapping, and retry behaviour.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Server } from 'node:http'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'
import { ServiceBoardClient, BoardServiceError } from './service-client'
import type { BoardBackendPort } from './port'

const FAKE_TENANT: TenantContext = {
  id: 'tenant-uuid-board',
  slug: 'board-test',
} as unknown as TenantContext

interface CapturedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

interface StubBehaviour {
  firstStatus?: number
  subsequentStatus?: number
  body?: unknown
  callCount: number
}

let server: Server
let port: number
let lastRequest: CapturedRequest | null = null
let stubBehaviour: StubBehaviour = { callCount: 0 }

function resetStub(opts: Omit<StubBehaviour, 'callCount'> = {}) {
  lastRequest = null
  stubBehaviour = { callCount: 0, ...opts }
}

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    stubBehaviour.callCount++
    const callIdx = stubBehaviour.callCount
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const rawBody = Buffer.concat(chunks).toString('utf8')
    let parsedBody: unknown = undefined
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody)
      } catch {
        parsedBody = rawBody
      }
    }
    lastRequest = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: parsedBody,
    }
    const status =
      callIdx === 1
        ? (stubBehaviour.firstStatus ?? 200)
        : (stubBehaviour.subsequentStatus ?? stubBehaviour.firstStatus ?? 200)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(stubBehaviour.body ?? {}))
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
})

beforeEach(() => {
  process.env.BOARD_SERVICE_URL = `http://127.0.0.1:${port}`
  process.env.INTERNAL_BOARD_SECRET = 'board-secret-5678'
  resetStub({ body: {} })
})

function withTenant<T>(fn: () => T): T {
  return runWithTenant(FAKE_TENANT, fn)
}

function makeBoardBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    org_unit_id: 'ou-1',
    name: 'StuRa',
    archived: false,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

function makeCardBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    stack_id: 's1',
    title: 'Neu',
    description: null,
    assignee_keycloak_id: null,
    due_date: null,
    label: null,
    sort_order: 0,
    protocol_action_item_id: null,
    created_by: 'u1',
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('ServiceBoardClient — kind', () => {
  it('has kind === service', () => {
    const client: BoardBackendPort = new ServiceBoardClient()
    expect(client.kind).toBe('service')
  })
})

describe('ServiceBoardClient — header forwarding', () => {
  it('forwards x-tenant-id, x-tenant-slug, and x-internal-auth on createCard', async () => {
    resetStub({ firstStatus: 201, body: makeCardBody() })
    const client = new ServiceBoardClient()
    await withTenant(() => client.createCard({ stackId: 's1', title: 'Neu', createdBy: 'u1' }))
    expect(lastRequest).not.toBeNull()
    expect(lastRequest!.headers['x-tenant-id']).toBe('tenant-uuid-board')
    expect(lastRequest!.headers['x-tenant-slug']).toBe('board-test')
    expect(lastRequest!.headers['x-internal-auth']).toBe('board-secret-5678')
  })

  it('forwards x-correlation-id when provided in constructor', async () => {
    resetStub({ body: { data: [] } })
    const client = new ServiceBoardClient({ correlationId: 'corr-abc' })
    await withTenant(() => client.listBoardsForOrgUnits(['ou-1']))
    expect(lastRequest!.headers['x-correlation-id']).toBe('corr-abc')
  })

  it('omits x-correlation-id when not provided', async () => {
    resetStub({ body: { data: [] } })
    const client = new ServiceBoardClient()
    await withTenant(() => client.listBoardsForOrgUnits(['ou-1']))
    expect(lastRequest!.headers['x-correlation-id']).toBeUndefined()
  })
})

describe('ServiceBoardClient — error mapping', () => {
  it('getBoard returns null when leaf returns 404', async () => {
    resetStub({ firstStatus: 404, body: { error: 'not found' } })
    const client = new ServiceBoardClient()
    const result = await withTenant(() => client.getBoard('missing'))
    expect(result).toBeNull()
  })

  it('moveCard returns null when leaf returns 404', async () => {
    resetStub({ firstStatus: 404, body: { error: 'not found' } })
    const client = new ServiceBoardClient()
    const result = await withTenant(() => client.moveCard('missing', { stackId: 's2', order: 0 }))
    expect(result).toBeNull()
  })

  it('deckFor THROWS BoardServiceError on 404 (preserves the boardDb throw semantics)', async () => {
    resetStub({ firstStatus: 404, body: { error: 'board not found' } })
    const client = new ServiceBoardClient()
    await expect(withTenant(() => client.deckFor('missing'))).rejects.toSatisfy(
      (e: unknown) => e instanceof BoardServiceError && e.status === 404,
    )
  })

  it('throws BoardServiceError with the status on POST 500', async () => {
    resetStub({ firstStatus: 500, body: { error: 'boom' } })
    const client = new ServiceBoardClient()
    await expect(
      withTenant(() => client.createCard({ stackId: 's1', title: 'x', createdBy: 'u1' })),
    ).rejects.toSatisfy((e: unknown) => e instanceof BoardServiceError && e.status === 500)
    expect(stubBehaviour.callCount).toBe(1) // POST must NOT retry
  })

  it('throws when BOARD_SERVICE_URL is not set', async () => {
    delete process.env.BOARD_SERVICE_URL
    const client = new ServiceBoardClient()
    await expect(withTenant(() => client.listBoardsForOrgUnits(['ou-1']))).rejects.toThrow(
      /BOARD_SERVICE_URL/,
    )
    process.env.BOARD_SERVICE_URL = `http://127.0.0.1:${port}`
  })

  it('throws when INTERNAL_BOARD_SECRET is not set', async () => {
    delete process.env.INTERNAL_BOARD_SECRET
    const client = new ServiceBoardClient()
    await expect(withTenant(() => client.listBoardsForOrgUnits(['ou-1']))).rejects.toThrow(
      /INTERNAL_BOARD_SECRET/,
    )
    process.env.INTERNAL_BOARD_SECRET = 'board-secret-5678'
  })

  it('throws BoardServiceError status 503 when leaf returns 503 on both attempts (GET)', async () => {
    resetStub({ firstStatus: 503, subsequentStatus: 503, body: { error: 'unavailable' } })
    const client = new ServiceBoardClient()
    await expect(withTenant(() => client.listBoardsForOrgUnits(['ou-1']))).rejects.toSatisfy(
      (e: unknown) => e instanceof BoardServiceError && e.status === 503,
    )
  })
})

describe('ServiceBoardClient — retry policy', () => {
  it('retries once on GET when leaf returns 503 then 200', async () => {
    resetStub({ firstStatus: 503, subsequentStatus: 200, body: { data: [] } })
    const client = new ServiceBoardClient()
    const result = await withTenant(() => client.listBoardsForOrgUnits(['ou-1']))
    expect(Array.isArray(result)).toBe(true)
    expect(stubBehaviour.callCount).toBe(2)
  })

  it('does NOT retry on POST even when leaf returns 503', async () => {
    resetStub({ firstStatus: 503, subsequentStatus: 200, body: makeCardBody() })
    const client = new ServiceBoardClient()
    await expect(
      withTenant(() => client.createCard({ stackId: 's1', title: 'x', createdBy: 'u1' })),
    ).rejects.toSatisfy((e: unknown) => e instanceof BoardServiceError && e.status === 503)
    expect(stubBehaviour.callCount).toBe(1)
  })
})

describe('ServiceBoardClient — method routing', () => {
  it('listBoardsForOrgUnits → GET /api/v1/boards?orgUnitId=ou-1', async () => {
    resetStub({ body: { data: [makeBoardBody()] } })
    const client = new ServiceBoardClient()
    const result = await withTenant(() => client.listBoardsForOrgUnits(['ou-1']))
    expect(lastRequest!.method).toBe('GET')
    expect(lastRequest!.url).toContain('/api/v1/boards')
    expect(lastRequest!.url).toContain('orgUnitId=ou-1')
    expect(result[0]!.id).toBe('b1')
    expect(result[0]!.created_at).toBeInstanceOf(Date)
  })

  it('listBoardsForOrgUnits([]) short-circuits to [] without a leaf call', async () => {
    resetStub({ body: { data: [] } })
    const client = new ServiceBoardClient()
    const result = await withTenant(() => client.listBoardsForOrgUnits([]))
    expect(result).toEqual([])
    expect(stubBehaviour.callCount).toBe(0)
  })

  it('getBoard → GET /api/v1/boards/b1', async () => {
    resetStub({ body: makeBoardBody() })
    const client = new ServiceBoardClient()
    const result = await withTenant(() => client.getBoard('b1'))
    expect(lastRequest!.method).toBe('GET')
    expect(lastRequest!.url).toBe('/api/v1/boards/b1')
    expect(result!.id).toBe('b1')
    expect(result!.created_at).toBeInstanceOf(Date)
  })

  it('deckFor → GET /api/v1/boards/b1/deck', async () => {
    resetStub({ body: { board: makeBoardBody(), stacks: [], cards: [] } })
    const client = new ServiceBoardClient()
    const result = await withTenant(() => client.deckFor('b1'))
    expect(lastRequest!.method).toBe('GET')
    expect(lastRequest!.url).toBe('/api/v1/boards/b1/deck')
    expect(result.board.id).toBe('b1')
  })

  it('createCard → POST /api/v1/cards', async () => {
    resetStub({ firstStatus: 201, body: makeCardBody({ title: 'Neu' }) })
    const client = new ServiceBoardClient()
    const result = await withTenant(() => client.createCard({ stackId: 's1', title: 'Neu', createdBy: 'u1' }))
    expect(lastRequest!.method).toBe('POST')
    expect(lastRequest!.url).toBe('/api/v1/cards')
    expect((lastRequest!.body as Record<string, unknown>).title).toBe('Neu')
    expect(result.id).toBe('c1')
    expect(result.created_at).toBeInstanceOf(Date)
  })

  it('moveCard → PATCH /api/v1/cards/c1/move', async () => {
    resetStub({ body: makeCardBody({ stack_id: 's2' }) })
    const client = new ServiceBoardClient()
    const result = await withTenant(() => client.moveCard('c1', { stackId: 's2', order: 3 }))
    expect(lastRequest!.method).toBe('PATCH')
    expect(lastRequest!.url).toBe('/api/v1/cards/c1/move')
    expect((lastRequest!.body as Record<string, unknown>).stackId).toBe('s2')
    expect((lastRequest!.body as Record<string, unknown>).order).toBe(3)
    expect(result!.stack_id).toBe('s2')
  })

  it('promoteActionItem → POST /api/v1/boards/b1/promote', async () => {
    resetStub({ firstStatus: 201, body: makeCardBody({ label: 'Sitzung', protocol_action_item_id: 'ai-1' }) })
    const client = new ServiceBoardClient()
    const item = { id: 'ai-1', text: 'Do it', assigneeKeycloakId: null, dueDate: null }
    const result = await withTenant(() => client.promoteActionItem('b1', item, 'u1'))
    expect(lastRequest!.method).toBe('POST')
    expect(lastRequest!.url).toBe('/api/v1/boards/b1/promote')
    expect((lastRequest!.body as Record<string, unknown>).createdBy).toBe('u1')
    expect(result.protocol_action_item_id).toBe('ai-1')
  })

  it('listPromotedActionItemIds → POST /api/v1/cards/promoted with a JSON body (#384, #387)', async () => {
    resetStub({ body: { data: ['ai-2'] } })
    const client = new ServiceBoardClient()
    const result = await withTenant(() => client.listPromotedActionItemIds(['ai-1', 'ai-2']))
    expect(lastRequest!.method).toBe('POST')
    expect(lastRequest!.url).toBe('/api/v1/cards/promoted')
    // Ids travel in the POST body, NOT as repeated query params (16KB header cap).
    expect(lastRequest!.url).not.toContain('actionItemId')
    expect((lastRequest!.body as Record<string, unknown>).candidateIds).toEqual(['ai-1', 'ai-2'])
    expect(result).toEqual(['ai-2'])
  })

  it('listPromotedActionItemIds([]) short-circuits to [] without a leaf call', async () => {
    resetStub({ body: { data: [] } })
    const client = new ServiceBoardClient()
    const result = await withTenant(() => client.listPromotedActionItemIds([]))
    expect(result).toEqual([])
    expect(stubBehaviour.callCount).toBe(0)
  })
})

describe('ServiceBoardClient — create path (R29-BOARD-STORE-S B5)', () => {
  it('createBoard → POST /api/v1/boards with the input as body; deserialises { board, stacks }', async () => {
    resetStub({
      firstStatus: 201,
      body: {
        board: makeBoardBody({ id: 'b7', name: 'Vorstand' }),
        stacks: [
          { id: 's1', board_id: 'b7', name: 'To Do', sort_order: 0 },
          { id: 's2', board_id: 'b7', name: 'Done', sort_order: 1 },
        ],
      },
    })
    const client = new ServiceBoardClient()
    const input = { orgUnitId: 'ou-1', name: 'Vorstand', archived: false, stacks: ['To Do', 'Done'] }
    const result = await withTenant(() => client.createBoard(input))
    expect(lastRequest!.method).toBe('POST')
    expect(lastRequest!.url).toBe('/api/v1/boards')
    expect(lastRequest!.body).toEqual(input)
    expect(lastRequest!.headers['x-tenant-id']).toBe('tenant-uuid-board')
    expect(lastRequest!.headers['x-tenant-slug']).toBe('board-test')
    expect(lastRequest!.headers['x-internal-auth']).toBe('board-secret-5678')
    expect(result.board.id).toBe('b7')
    expect(result.board.created_at).toBeInstanceOf(Date)
    expect(result.stacks.map((s) => [s.name, s.sort_order])).toEqual([
      ['To Do', 0],
      ['Done', 1],
    ])
  })

  it('createBoard THROWS on a 201 without the { board, stacks } shape (fail loud)', async () => {
    resetStub({ firstStatus: 201, body: makeBoardBody() })
    const client = new ServiceBoardClient()
    await expect(
      withTenant(() => client.createBoard({ orgUnitId: 'ou-1', name: 'x' })),
    ).rejects.toThrow(/malformed createBoard response/)
  })

  it('createBoard does NOT retry a POST, even on 503', async () => {
    resetStub({ firstStatus: 503, subsequentStatus: 201, body: { board: makeBoardBody(), stacks: [] } })
    const client = new ServiceBoardClient()
    await expect(
      withTenant(() => client.createBoard({ orgUnitId: 'ou-1', name: 'x' })),
    ).rejects.toSatisfy((e: unknown) => e instanceof BoardServiceError && e.status === 503)
    expect(stubBehaviour.callCount).toBe(1)
  })

  it('createStack → POST /api/v1/boards/b1/stacks with { name, order }; returns the Stack', async () => {
    resetStub({ firstStatus: 201, body: { id: 's9', board_id: 'b1', name: 'Review', sort_order: 3 } })
    const client = new ServiceBoardClient()
    const result = await withTenant(() => client.createStack('b1', { name: 'Review', order: 3 }))
    expect(lastRequest!.method).toBe('POST')
    expect(lastRequest!.url).toBe('/api/v1/boards/b1/stacks')
    expect(lastRequest!.body).toEqual({ name: 'Review', order: 3 })
    expect(result).toEqual({ id: 's9', board_id: 'b1', name: 'Review', sort_order: 3 })
  })

  it('createStack does NOT retry and surfaces a 404 as BoardServiceError (never a silent null)', async () => {
    resetStub({ firstStatus: 404, subsequentStatus: 201, body: { error: 'board not found' } })
    const client = new ServiceBoardClient()
    await expect(
      withTenant(() => client.createStack('missing', { name: 'x', order: 0 })),
    ).rejects.toSatisfy((e: unknown) => e instanceof BoardServiceError && e.status === 404)
    expect(stubBehaviour.callCount).toBe(1)
  })
})

describe('ServiceBoardClient — malformed-200 shape guard (#387)', () => {
  it('listPromotedActionItemIds THROWS on a 200 missing the { data: [] } envelope (fail-loud, not fail-open)', async () => {
    resetStub({ firstStatus: 200, body: { oops: true } })
    const client = new ServiceBoardClient()
    await expect(
      withTenant(() => client.listPromotedActionItemIds(['ai-1'])),
    ).rejects.toThrow(/malformed listPromotedActionItemIds response/)
  })

  it('listPromotedActionItemIds THROWS when data is present but not an array', async () => {
    resetStub({ firstStatus: 200, body: { data: 'nope' } })
    const client = new ServiceBoardClient()
    await expect(
      withTenant(() => client.listPromotedActionItemIds(['ai-1'])),
    ).rejects.toThrow(/malformed listPromotedActionItemIds response/)
  })

  it('listBoardsForOrgUnits THROWS on a 200 missing the { data: [] } envelope (kept consistent)', async () => {
    resetStub({ firstStatus: 200, body: {} })
    const client = new ServiceBoardClient()
    await expect(
      withTenant(() => client.listBoardsForOrgUnits(['ou-1'])),
    ).rejects.toThrow(/malformed listBoardsForOrgUnits response/)
  })
})
