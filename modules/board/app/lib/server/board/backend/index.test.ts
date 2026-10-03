// gremion-ui/src/lib/server/board/backend/index.test.ts
// T1 — unit test for getBoardBackend() factory (fail-closed).
//
// Pins:
//   1. BOARD_BACKEND unset → InprocessBoardClient (kind='inprocess')
//   2. BOARD_BACKEND='inprocess' → InprocessBoardClient
//   3. BOARD_BACKEND='service' → ServiceBoardClient (kind='service')
//   4. BOARD_BACKEND=<unknown> → throws with /BOARD_BACKEND/ in message (fail-closed)

import { describe, it, expect, afterEach, vi } from 'vitest'

// ── Mock board-db (InprocessBoardClient imports { boardDb } at module level) ──
vi.mock('../board-db', () => ({
  boardDb: {
    createBoard: vi.fn(),
    listBoardsForOrgUnits: vi.fn(),
    getBoard: vi.fn(),
    createStack: vi.fn(),
    createCard: vi.fn(),
    moveCard: vi.fn(),
    updateCard: vi.fn(),
    deckFor: vi.fn(),
    promoteActionItem: vi.fn(),
    listPromotedActionItemIds: vi.fn(),
  },
}))

// ServiceBoardClient reads getTenant() on each method call (not at construction),
// so constructing it does not touch tenant context — no mock needed here.
vi.mock('$lib/server/tenant/context', () => ({
  currentTenantId: () => 'default',
  getTenant: () => ({ id: 'default', slug: 'default' }),
  runWithTenant: (_ctx: unknown, fn: () => unknown) => fn(),
}))

import { getBoardBackend } from './index'
import { InprocessBoardClient } from './inprocess-client'
import { ServiceBoardClient } from './service-client'

const savedEnv = process.env.BOARD_BACKEND

afterEach(() => {
  if (savedEnv === undefined) delete process.env.BOARD_BACKEND
  else process.env.BOARD_BACKEND = savedEnv
  vi.restoreAllMocks()
})

describe('getBoardBackend() factory', () => {
  it('returns InprocessBoardClient when BOARD_BACKEND is unset', () => {
    delete process.env.BOARD_BACKEND
    const backend = getBoardBackend()
    expect(backend).toBeInstanceOf(InprocessBoardClient)
    expect(backend.kind).toBe('inprocess')
  })

  it('returns InprocessBoardClient when BOARD_BACKEND=inprocess', () => {
    process.env.BOARD_BACKEND = 'inprocess'
    const backend = getBoardBackend()
    expect(backend).toBeInstanceOf(InprocessBoardClient)
    expect(backend.kind).toBe('inprocess')
  })

  it('returns ServiceBoardClient when BOARD_BACKEND=service', () => {
    process.env.BOARD_BACKEND = 'service'
    const backend = getBoardBackend('corr-123')
    expect(backend).toBeInstanceOf(ServiceBoardClient)
    expect(backend.kind).toBe('service')
  })

  it('throws with /BOARD_BACKEND/ when given an unknown value (fail-closed)', () => {
    process.env.BOARD_BACKEND = 'unknown-backend'
    expect(() => getBoardBackend()).toThrow(/BOARD_BACKEND/)
  })

  it('includes the bad value in the error message', () => {
    process.env.BOARD_BACKEND = 'redis'
    expect(() => getBoardBackend()).toThrow(/redis/)
  })

  it('both backends expose the create path createBoard + createStack (R29-BOARD-STORE-S B5)', () => {
    for (const value of ['inprocess', 'service']) {
      process.env.BOARD_BACKEND = value
      const backend = getBoardBackend()
      expect(typeof backend.createBoard, value).toBe('function')
      expect(typeof backend.createStack, value).toBe('function')
    }
  })
})
