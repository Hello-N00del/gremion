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

import { error, isHttpError } from '@sveltejs/kit'
import { resolveBoardBackendOr503, resolveBoardBackendForPage, mapBoardUnavailable, mapBoardUnavailableForPage } from './resolve'
import { InprocessBoardClient } from './inprocess-client'
import { RoutedBoardBackend } from './routed-client'
import { BoardMovingError, BoardLocationUnreadableError } from './location'

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

  it('default mode (env unset) returns the router, not a Response', () => {
    delete process.env.BOARD_BACKEND
    const result = resolveBoardBackendOr503()
    expect(result).not.toBeInstanceOf(Response)
    expect(result).toBeInstanceOf(RoutedBoardBackend)
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

  it('default mode (env unset) returns the router', () => {
    delete process.env.BOARD_BACKEND
    expect(resolveBoardBackendForPage()).toBeInstanceOf(RoutedBoardBackend)
  })
})

describe('mapBoardUnavailable — the 503 errors of the router on an API route', () => {
  const ok = new Response('fine', { status: 200 })

  it('passes a normal response through', async () => {
    const handler = mapBoardUnavailable(async () => ok)
    expect(await handler({} as never)).toBe(ok)
  })

  it('a write during a move is a 503 with Retry-After 5 and the German text', async () => {
    const handler = mapBoardUnavailable(async () => {
      throw new BoardMovingError()
    })
    const res = await handler({} as never)
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('5')
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ message: 'Das Board wird gerade verschoben.' })
  })

  it('an unreadable flag is a 503 with its own Retry-After and text', async () => {
    const handler = mapBoardUnavailable(async () => {
      throw new BoardLocationUnreadableError(new Error('db down'))
    })
    const res = await handler({} as never)
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('30')
    expect(await res.json()).toEqual({ message: 'Das Board ist momentan nicht verfügbar.' })
  })

  it('never leaks the cause of the failure into the response', async () => {
    const handler = mapBoardUnavailable(async () => {
      throw new BoardLocationUnreadableError(new Error('password authentication failed for user x'))
    })
    expect(await (await handler({} as never)).text()).not.toContain('password')
  })

  it('SvelteKit errors (403, 404, 400) pass through untouched', async () => {
    const handler = mapBoardUnavailable(async () => {
      error(403, 'Forbidden')
    })
    expect(isHttpError(await handler({} as never).catch((e) => e))).toBe(true)
    await expect(handler({} as never)).rejects.toMatchObject({ status: 403 })
  })

  it('any other error is rethrown as it is', async () => {
    const boom = new Error('boom')
    const handler = mapBoardUnavailable(async () => {
      throw boom
    })
    await expect(handler({} as never)).rejects.toBe(boom)
  })
})

describe('mapBoardUnavailableForPage — the 503 errors of the router in a page load', () => {
  it('returns the load result', async () => {
    const load = mapBoardUnavailableForPage(async () => ({ a: 1 }))
    expect(await load({} as never)).toEqual({ a: 1 })
  })

  it.each([new BoardMovingError(), new BoardLocationUnreadableError()])('turns %s into error(503) with the German text', async (err) => {
    const load = mapBoardUnavailableForPage(async () => {
      throw err
    })
    await expect(load({} as never)).rejects.toMatchObject({ status: 503, body: { message: err.message } })
  })

  it('passes SvelteKit errors and other errors through', async () => {
    const forbidden = mapBoardUnavailableForPage(async () => {
      error(403, 'Forbidden')
    })
    await expect(forbidden({} as never)).rejects.toMatchObject({ status: 403 })
    const boom = new Error('boom')
    const broken = mapBoardUnavailableForPage(async () => {
      throw boom
    })
    await expect(broken({} as never)).rejects.toBe(boom)
  })
})
