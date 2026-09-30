// services/board/test/routes.test.ts
// Route-table contract (PG-free): buildApiRoutes() must expose EXACTLY the six
// BoardBackendPort endpoints the kernel's ServiceBoardClient calls, and the
// router must extract their path params. The store is never touched here (the
// injected storeFn throws if a handler is dispatched) — handler behaviour is
// covered by api.integration.test.ts against a real Postgres.
import { describe, it, expect } from 'vitest'
import { buildApiRoutes } from '../src/http/routes.ts'
import { createRouter } from '../src/http/router.ts'
import type { Sql, TenantRef } from '../src/store/index.ts'

const storeThatThrows = (_t: TenantRef): Promise<Sql> => {
  throw new Error('store must not be reached in a routing-only test')
}

const routes = buildApiRoutes(storeThatThrows)
const router = createRouter(routes)

describe('board leaf route table — exact endpoint set', () => {
  it('registers exactly the nine BoardBackendPort endpoints (seven + the two create routes, R29-BOARD-STORE-K A5)', () => {
    const set = routes.map((r) => `${r.method} ${r.path}`).sort()
    expect(set).toEqual(
      [
        'GET /api/v1/boards',
        'POST /api/v1/boards',
        'GET /api/v1/boards/:id',
        'GET /api/v1/boards/:id/deck',
        'POST /api/v1/boards/:id/stacks',
        'POST /api/v1/cards',
        'PATCH /api/v1/cards/:id/move',
        'POST /api/v1/cards/promoted',
        'POST /api/v1/boards/:id/promote',
      ].sort(),
    )
  })
})

describe('board leaf create routes', () => {
  it('matches POST /api/v1/boards (create a board with its stacks)', () => {
    const m = router.match('POST', '/api/v1/boards')
    expect(m.type).toBe('matched')
    if (m.type !== 'matched') throw new Error('unreachable')
    expect(m.params).toEqual({})
  })

  it('extracts :id for POST /api/v1/boards/:id/stacks', () => {
    const m = router.match('POST', '/api/v1/boards/b-5/stacks')
    expect(m.type).toBe('matched')
    if (m.type !== 'matched') throw new Error('unreachable')
    expect(m.params).toEqual({ id: 'b-5' })
  })
})

describe('board leaf router — path-param matching', () => {
  it('matches GET /api/v1/boards (list)', () => {
    expect(router.match('GET', '/api/v1/boards').type).toBe('matched')
  })

  it('extracts :id for GET /api/v1/boards/:id', () => {
    const m = router.match('GET', '/api/v1/boards/b-42')
    expect(m.type).toBe('matched')
    if (m.type !== 'matched') throw new Error('unreachable')
    expect(m.params).toEqual({ id: 'b-42' })
  })

  it('extracts :id for GET /api/v1/boards/:id/deck', () => {
    const m = router.match('GET', '/api/v1/boards/b-7/deck')
    expect(m.type).toBe('matched')
    if (m.type !== 'matched') throw new Error('unreachable')
    expect(m.params).toEqual({ id: 'b-7' })
  })

  it('extracts :id for PATCH /api/v1/cards/:id/move', () => {
    const m = router.match('PATCH', '/api/v1/cards/c-9/move')
    expect(m.type).toBe('matched')
    if (m.type !== 'matched') throw new Error('unreachable')
    expect(m.params).toEqual({ id: 'c-9' })
  })

  it('extracts :id for POST /api/v1/boards/:id/promote', () => {
    const m = router.match('POST', '/api/v1/boards/b-3/promote')
    expect(m.type).toBe('matched')
    if (m.type !== 'matched') throw new Error('unreachable')
    expect(m.params).toEqual({ id: 'b-3' })
  })

  it('matches the static POST /api/v1/cards/promoted path with no params (#384, #387)', () => {
    const m = router.match('POST', '/api/v1/cards/promoted')
    expect(m.type).toBe('matched')
    if (m.type !== 'matched') throw new Error('unreachable')
    expect(m.params).toEqual({})
  })

  it('does NOT let POST /api/v1/cards/promoted fall through to POST /api/v1/cards', () => {
    // Distinct static paths — the promoted route must win, not the create-card route.
    const m = router.match('POST', '/api/v1/cards/promoted')
    expect(m.type).toBe('matched')
    const create = router.match('POST', '/api/v1/cards')
    expect(create.type).toBe('matched')
  })

  it('returns method-not-allowed for DELETE on the list path (GET and POST only)', () => {
    const m = router.match('DELETE', '/api/v1/boards')
    expect(m.type).toBe('method-not-allowed')
    if (m.type !== 'method-not-allowed') throw new Error('unreachable')
    expect([...m.allowed].sort()).toEqual(['GET', 'POST'])
  })

  it('returns not-found for an unregistered path', () => {
    expect(router.match('GET', '/api/v1/nope').type).toBe('not-found')
  })
})
