// gremion-ui/src/lib/server/board/backend/resolve.test.ts
// T1 — graceful-503 contract for the board backend resolver.
//
// Pins:
//   1. resolveBoardBackendOr503() → returns 503 Response on construction error
//   2. resolveBoardBackendOr503() → does NOT throw on unknown backend
//   3. resolveBoardBackendOr503() → returns InprocessBoardClient when env unset
//   4. resolveBoardBackendForPage() → throws SvelteKit error(503) on construction error
//   5. resolveBoardBackendForPage() → returns InprocessBoardClient when env unset

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock board-db so InprocessBoardClient can be constructed without a real DB.
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
  },
}))

// Stub tenant context so neither client hits a real tenant store during construction.
vi.mock('$lib/server/tenant/context', () => ({
  currentTenantId: () => 'default',
  getTenant: () => ({ id: 'default', slug: 'default' }),
  runWithTenant: (_ctx: unknown, fn: () => unknown) => fn(),
}))

import { resolveBoardBackendOr503, resolveBoardBackendForPage } from './resolve'
import { InprocessBoardClient } from './inprocess-client'

const savedEnv = process.env.BOARD_BACKEND

beforeEach(() => {
  // Silence the intentional console.error from the 503 mapping path.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.BOARD_BACKEND
  else process.env.BOARD_BACKEND = savedEnv
  vi.restoreAllMocks()
})

describe('resolveBoardBackendOr503 — unknown backend maps to graceful 503', () => {
  it('returns a 503 Response (with Retry-After) when BOARD_BACKEND=invalid-backend', () => {
    process.env.BOARD_BACKEND = 'invalid-backend'
    const result = resolveBoardBackendOr503()
    expect(result).toBeInstanceOf(Response)
    const res = result as Response
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('30')
  })

  it('does NOT throw for an unknown backend (no 500 / uncaught)', () => {
    process.env.BOARD_BACKEND = 'invalid-backend'
    expect(() => resolveBoardBackendOr503()).not.toThrow()
  })

  it('default mode (env unset) returns an InprocessBoardClient, not a Response', () => {
    delete process.env.BOARD_BACKEND
    const result = resolveBoardBackendOr503()
    expect(result).not.toBeInstanceOf(Response)
    expect(result).toBeInstanceOf(InprocessBoardClient)
  })

  it('inprocess mode returns an InprocessBoardClient', () => {
    process.env.BOARD_BACKEND = 'inprocess'
    const result = resolveBoardBackendOr503()
    expect(result).not.toBeInstanceOf(Response)
    expect(result).toBeInstanceOf(InprocessBoardClient)
  })
})

describe('resolveBoardBackendForPage — unknown backend throws error(503)', () => {
  it('throws a SvelteKit error with status 503 when BOARD_BACKEND=invalid-backend', () => {
    process.env.BOARD_BACKEND = 'invalid-backend'
    try {
      resolveBoardBackendForPage()
      expect.unreachable('expected resolveBoardBackendForPage to throw')
    } catch (err) {
      expect((err as { status?: number }).status).toBe(503)
    }
  })

  it('default mode (env unset) returns an InprocessBoardClient', () => {
    delete process.env.BOARD_BACKEND
    expect(resolveBoardBackendForPage()).toBeInstanceOf(InprocessBoardClient)
  })
})
