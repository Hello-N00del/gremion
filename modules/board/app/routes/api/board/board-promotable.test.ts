// #384 — /api/board/[id]/promotable regression tests, both backend modes.
//
// The route used to filter promoted items with a raw kernel-DB
// `NOT EXISTS (SELECT 1 FROM card …)`, which under BOARD_BACKEND=service read
// an empty `card` relation (the table lives in the leaf) and re-offered
// already-promoted items. It now fetches the OPEN kernel action items, asks the
// BoardBackendPort for the promoted id-subset, and filters in code. These tests
// pin: (a) inprocess parity — same items, same order as the old single query,
// via the REAL InprocessBoardClient over a mocked boardDb; (b) service-mode
// exclusion — promoted ids are filtered using ONLY the port (the stub port is
// the single source of card knowledge; getDb() here has no card data at all).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockResolveBackend, mockGetBoard, mockListPromotedActionItemIds, mockSql } = vi.hoisted(() => ({
  mockResolveBackend: vi.fn(),
  mockGetBoard: vi.fn(),
  mockListPromotedActionItemIds: vi.fn(),
  mockSql: vi.fn(),
}))

vi.mock('$lib/server/board/scope', () => ({ resolveBoardOrgUnitScope: vi.fn(async () => ['ou-1']) }))
vi.mock('$lib/server/board/backend/resolve', () => ({ resolveBoardBackendOr503: mockResolveBackend }))
vi.mock('$lib/server/board/board-db', () => ({
  boardDb: {
    getBoard: mockGetBoard,
    listPromotedActionItemIds: mockListPromotedActionItemIds,
  },
}))
// getDb() returns a tagged-template `sql` — the route calls it exactly once for
// the OPEN (kernel-side) action items. The rowset deliberately still CONTAINS
// the promoted items: only the port may remove them.
vi.mock('$lib/server/db', () => ({ getDb: () => mockSql }))
vi.mock('$lib/server/identity/display-names', () => ({
  getDisplayNameResolver: () => ({
    resolveMany: async () => new Map([['kc-1', 'Anna Berger']]),
  }),
}))

import { GET as promotable } from './[id]/promotable/+server'
import { InprocessBoardClient } from '$lib/server/board/backend/inprocess-client'

const member = { auth: async () => ({ user: { id: 'u1', roles: ['member'] } }) } as any
const BOARD = { id: 'b1', org_unit_id: 'ou-1', name: 'StuRa', archived: false, created_at: new Date() }

// Fixture in the exact ORDER BY p.meeting_date DESC, ai.created_at order the
// kernel query returns — the route must preserve it through the filter.
const OPEN_ITEMS = [
  { id: 'ai-1', text: 'Task eins', assignee_keycloak_id: 'kc-1', due_date: null, meeting_date: '2026-02-01' },
  { id: 'ai-2', text: 'Task zwei (schon promoted)', assignee_keycloak_id: null, due_date: null, meeting_date: '2026-01-01' },
  { id: 'ai-3', text: 'Task drei', assignee_keycloak_id: null, due_date: '2026-03-01', meeting_date: '2026-01-01' },
]

async function callRoute() {
  const res = await promotable({ params: { id: 'b1' }, locals: member } as any)
  return (await res.json()) as { data: Array<Record<string, unknown>> }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSql.mockResolvedValue(OPEN_ITEMS)
  mockGetBoard.mockResolvedValue(BOARD)
})

describe('GET /api/board/[id]/promotable — inprocess parity (#384)', () => {
  beforeEach(() => {
    // The REAL InprocessBoardClient over the mocked boardDb — the genuine
    // flag-OFF delegation path.
    mockResolveBackend.mockImplementation(() => new InprocessBoardClient())
  })

  it('filters the promoted id and preserves the kernel query order (old NOT EXISTS semantics)', async () => {
    mockListPromotedActionItemIds.mockResolvedValueOnce(['ai-2'])
    const body = await callRoute()
    expect(body.data.map((i) => i.id)).toEqual(['ai-1', 'ai-3'])
    // The port received EXACTLY the open candidate ids, in order.
    expect(mockListPromotedActionItemIds).toHaveBeenCalledWith(['ai-1', 'ai-2', 'ai-3'])
  })

  it('returns every open item unchanged when nothing is promoted (parity with the old query)', async () => {
    mockListPromotedActionItemIds.mockResolvedValueOnce([])
    const body = await callRoute()
    expect(body.data.map((i) => i.id)).toEqual(['ai-1', 'ai-2', 'ai-3'])
  })

  it('resolves assignee_name and never leaks the raw assignee UUID', async () => {
    mockListPromotedActionItemIds.mockResolvedValueOnce([])
    const body = await callRoute()
    expect(body.data[0]!.assignee_name).toBe('Anna Berger')
    expect(body.data[1]!.assignee_name).toBeNull()
    for (const item of body.data) expect(item).not.toHaveProperty('assignee_keycloak_id')
  })
})

describe('GET /api/board/[id]/promotable — service-mode exclusion (#384)', () => {
  it('filters promoted ids using ONLY the port (leaf-owned card knowledge)', async () => {
    const stubListPromoted = vi.fn(async () => ['ai-2', 'ai-3'])
    mockResolveBackend.mockReturnValueOnce({
      kind: 'service',
      getBoard: async () => BOARD,
      listPromotedActionItemIds: stubListPromoted,
    })
    const body = await callRoute()
    expect(body.data.map((i) => i.id)).toEqual(['ai-1'])
    expect(stubListPromoted).toHaveBeenCalledWith(['ai-1', 'ai-2', 'ai-3'])
    // The kernel boardDb card read must NOT be consulted in service mode.
    expect(mockListPromotedActionItemIds).not.toHaveBeenCalled()
  })
})
