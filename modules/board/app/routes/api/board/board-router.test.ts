// The board routes through the real router, for each place the board can live.
//
//   kernel → the kernel tables answer (boardDb)
//   moving → reads still come from the kernel tables; every write is a 503 with Retry-After 5 and
//            the German text, and the kernel tables are not touched
//   module → the board service answers, reads and writes
//   flag unreadable → 503, nothing is guessed
//
// The location reader is replaced by a stub that keeps the real error classes; boardDb and the
// service client are doubles that say which of them answered.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  location: vi.fn(),
  kernel: {
    listBoardsForOrgUnits: vi.fn(),
    getBoard: vi.fn(),
    deckFor: vi.fn(),
    createCard: vi.fn(),
    moveCard: vi.fn(),
    updateCard: vi.fn(),
    promoteActionItem: vi.fn(),
    listPromotedActionItemIds: vi.fn(),
    createBoardWithStacks: vi.fn(),
    createStack: vi.fn(),
  },
  service: {
    listBoardsForOrgUnits: vi.fn(),
    getBoard: vi.fn(),
    deckFor: vi.fn(),
    createCard: vi.fn(),
    moveCard: vi.fn(),
    updateCard: vi.fn(),
    promoteActionItem: vi.fn(),
    listPromotedActionItemIds: vi.fn(),
    createBoard: vi.fn(),
    createStack: vi.fn(),
  },
  sql: vi.fn(),
}))

vi.mock('$lib/server/tenant/context', () => ({
  currentTenantId: () => 'default',
  getTenant: () => ({ id: 'default', slug: 'default' }),
}))
vi.mock('$lib/server/board/backend/location', async (orig) => ({
  ...(await orig<typeof import('$lib/server/board/backend/location')>()),
  getBoardLocation: h.location,
}))
vi.mock('$lib/server/board/board-db', () => ({ boardDb: h.kernel }))
vi.mock('$lib/server/board/backend/service-client', () => ({
  BoardServiceError: class extends Error {},
  ServiceBoardClient: class {
    readonly kind = 'service'
    constructor() {
      Object.assign(this, h.service)
    }
  },
}))
vi.mock('$lib/server/board/scope', () => ({ resolveBoardOrgUnitScope: vi.fn(async () => ['ou-1', '11111111-1111-1111-1111-111111111111']) }))
vi.mock('$lib/server/db', () => ({ getDb: () => h.sql }))
vi.mock('$lib/server/identity/display-names', () => ({
  getDisplayNameResolver: () => ({ resolveMany: async () => new Map() }),
}))
vi.mock('$lib/server/governance/org-units-db', () => ({
  isMemberOf: vi.fn(async () => true),
  listOrgUnits: vi.fn(async () => [{ id: 'ou-1', name: 'StuRa' }]),
  listOrgUnitMembers: vi.fn(async () => []),
}))
vi.mock('$lib/server/protocols/protocol-db', () => ({
  getActionItem: vi.fn(async () => ({ id: 'ai-1', protocol_id: 'p1', text: 'Aufgabe', assignee_keycloak_id: null, due_date: null })),
  getProtocol: vi.fn(async () => ({ id: 'p1', committee_id: 'ou-1' })),
}))

import { GET as listBoards, POST as createBoard } from './+server'
import { GET as getDeck } from './[id]/+server'
import { POST as createCard, PATCH as patchCard } from './[id]/cards/+server'
import { POST as promote } from './[id]/promote/+server'
import { GET as promotable } from './[id]/promotable/+server'
import { load as tasksLoad } from '../../tasks/+page.server'
import { BoardLocationUnreadableError } from '$lib/server/board/backend/location'

const member = { auth: async () => ({ user: { id: 'u1', roles: ['member'] } }) } as any
const BOARD = { id: 'b1', org_unit_id: 'ou-1', name: 'x', archived: false, created_at: new Date() }
const DECK = {
  board: BOARD,
  stacks: [{ id: 's1', board_id: 'b1', name: 'Offen', sort_order: 0 }],
  cards: [{ id: 'c1', stack_id: 's1', assignee_keycloak_id: null, due_date: null }],
}
const CARD = { id: 'c1', stack_id: 's1', title: 'Neu' }

const json = (body: unknown) => new Request('http://x', { method: 'POST', body: JSON.stringify(body) })

/** Every route call, by name. READS keep working while a move copies the board, WRITES do not. */
const reads = {
  'GET /api/board': () => listBoards({ locals: member } as any),
  'GET /api/board/[id]': () => getDeck({ params: { id: 'b1' }, locals: member } as any),
  'GET /api/board/[id]/promotable': () => promotable({ params: { id: 'b1' }, locals: member } as any),
  '/tasks load': () => tasksLoad({ locals: member, url: new URL('http://x/tasks') } as any) as Promise<unknown>,
}
const writes = {
  'POST /api/board': () => createBoard({ request: json({ orgUnitId: '11111111-1111-1111-1111-111111111111' }), locals: member } as any),
  'POST /api/board/[id]/cards': () => createCard({ params: { id: 'b1' }, request: json({ stackId: 's1', title: 'Neu' }), locals: member } as any),
  'PATCH /api/board/[id]/cards (move)': () =>
    patchCard({ params: { id: 'b1' }, request: new Request('http://x', { method: 'PATCH', body: JSON.stringify({ cardId: 'c1', stackId: 's1', order: 0 }) }), locals: member } as any),
  'PATCH /api/board/[id]/cards (edit)': () =>
    patchCard({ params: { id: 'b1' }, request: new Request('http://x', { method: 'PATCH', body: JSON.stringify({ cardId: 'c1', title: 'Neu' }) }), locals: member } as any),
  'POST /api/board/[id]/promote': () => promote({ params: { id: 'b1' }, request: json({ actionItemId: 'ai-1' }), locals: member } as any),
}

const ALL_KERNEL = Object.values(h.kernel)
const ALL_SERVICE = Object.values(h.service)

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  for (const d of [h.kernel, h.service]) {
    d.getBoard.mockResolvedValue(BOARD)
    d.deckFor.mockResolvedValue(DECK)
    d.listBoardsForOrgUnits.mockResolvedValue([BOARD])
    d.listPromotedActionItemIds.mockResolvedValue([])
    d.createCard.mockResolvedValue(CARD)
    d.moveCard.mockResolvedValue(CARD)
    d.updateCard.mockResolvedValue(CARD)
    d.promoteActionItem.mockResolvedValue(CARD)
    d.createStack.mockResolvedValue({ id: 's1' })
  }
  h.kernel.createBoardWithStacks.mockResolvedValue({ board: BOARD, stacks: [] })
  h.service.createBoard.mockResolvedValue({ board: BOARD, stacks: [] })
  // listBoardsForOrgUnits answers an empty list for the create check, so the create goes ahead
  h.kernel.listBoardsForOrgUnits.mockImplementation(async (ids: string[]) => (ids.length === 1 ? [] : [BOARD]))
  h.service.listBoardsForOrgUnits.mockImplementation(async (ids: string[]) => (ids.length === 1 ? [] : [BOARD]))
  h.sql.mockResolvedValue([{ id: 'ai-1', text: 'Aufgabe', assignee_keycloak_id: null, due_date: null, meeting_date: '2026-01-01' }])
})

const statusOf = (r: unknown) => (r as Response).status
// a page load returns data, not a Response: nothing was refused, which reads as 200
const statusIfResponse = (r: unknown) => (r instanceof Response ? r.status : 200)

describe.each(Object.entries(reads))('read: %s', (_name, run) => {
  it('kernel: answers from the kernel tables only', async () => {
    h.location.mockResolvedValue('kernel')
    await run()
    expect(ALL_KERNEL.some((m) => m.mock.calls.length > 0)).toBe(true)
    expect(ALL_SERVICE.every((m) => m.mock.calls.length === 0)).toBe(true)
  })

  it('moving: still answers, from the kernel tables only', async () => {
    h.location.mockResolvedValue('moving')
    const res = await run()
    expect(statusIfResponse(res)).toBe(200)
    expect(ALL_KERNEL.some((m) => m.mock.calls.length > 0)).toBe(true)
    expect(ALL_SERVICE.every((m) => m.mock.calls.length === 0)).toBe(true)
  })

  it('module: answers from the board service only', async () => {
    h.location.mockResolvedValue('module')
    await run()
    expect(ALL_SERVICE.some((m) => m.mock.calls.length > 0)).toBe(true)
    expect(ALL_KERNEL.every((m) => m.mock.calls.length === 0)).toBe(true)
  })
})

describe.each(Object.entries(writes))('write: %s', (_name, run) => {
  it('kernel: written to the kernel tables only', async () => {
    h.location.mockResolvedValue('kernel')
    expect([200, 201]).toContain(statusOf(await run()))
    expect(ALL_SERVICE.every((m) => m.mock.calls.length === 0)).toBe(true)
  })

  it('moving: 503 with Retry-After 5 and the German text, and nothing is written', async () => {
    h.location.mockResolvedValue('moving')
    const res = (await run()) as Response
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('5')
    expect(await res.json()).toEqual({ message: 'Das Board wird gerade verschoben.' })
    const writers = [h.kernel.createCard, h.kernel.moveCard, h.kernel.updateCard, h.kernel.promoteActionItem, h.kernel.createBoardWithStacks, h.kernel.createStack]
    expect(writers.every((m) => m.mock.calls.length === 0)).toBe(true)
    expect(ALL_SERVICE.every((m) => m.mock.calls.length === 0)).toBe(true)
  })

  it('module: written through the board service only', async () => {
    h.location.mockResolvedValue('module')
    expect([200, 201]).toContain(statusOf(await run()))
    expect(ALL_KERNEL.every((m) => m.mock.calls.length === 0)).toBe(true)
  })
})

describe('a flag that cannot be read', () => {
  const UNREADABLE = 'Das Board ist momentan nicht verfügbar.'
  const untouched = () => {
    expect(ALL_KERNEL.every((m) => m.mock.calls.length === 0)).toBe(true)
    expect(ALL_SERVICE.every((m) => m.mock.calls.length === 0)).toBe(true)
  }

  // guard: watched RED by a router that falls back to the kernel tables
  const apiRoutes = [...Object.entries(reads), ...Object.entries(writes)].filter(([name]) => name !== '/tasks load')
  it.each(apiRoutes)('%s: 503 with Retry-After, and no table or service is touched', async (_name, run) => {
    h.location.mockRejectedValue(new BoardLocationUnreadableError(new Error('db down')))
    const res = (await run()) as Response
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('30')
    expect(await res.json()).toEqual({ message: UNREADABLE })
    untouched()
  })

  it('/tasks load: error 503 with the German text, and no table or service is touched', async () => {
    h.location.mockRejectedValue(new BoardLocationUnreadableError(new Error('db down')))
    await expect(reads['/tasks load']()).rejects.toMatchObject({ status: 503, body: { message: UNREADABLE } })
    untouched()
  })
})
