// modules/board/test/isolation/case.test.ts
//
// R29-BOARD-STORE-K A9 (PG-free): the board isolation case in TASK-044's
// contract shape, validated against the leaf's OWN route table, and the
// harness's rules (controls first, harness-owned verdicts, vacuity) proven on
// stub cases. Fails when a route is missing from attempts or controls, or when
// a route lacks the read or write attempt it needs.
import { describe, it, expect } from 'vitest'
import { buildApiRoutes } from '../../src/http/routes.ts'
import type { TenantRef } from '../../src/store/index.ts'
import type { ApiResult, BoardApi } from './api.ts'
import { BOARD_ROUTE_KINDS, boardIsolationCase, type Attempt, type BoardRecord, type Control, type IsolationCase } from './case.ts'
import { runIsolation, validateCase } from './harness.ts'
import { everyRouteCall } from '../support/route-calls.ts'
import { TENANT_A, TENANT_B } from '../support/tenants.ts'

const ROUTE_TABLE = buildApiRoutes(() => {
  throw new Error('the store is never reached in a PG-free test')
})
  .map((r) => `${r.method} ${r.path}`)
  .sort()

const unreachable = (): Promise<ApiResult> => Promise.reject(new Error('not called'))
const api: BoardApi = {
  listBoards: unreachable,
  getBoard: unreachable,
  deck: unreachable,
  createBoard: unreachable,
  createStack: unreachable,
  createCard: unreachable,
  moveCard: unreachable,
  promote: unreachable,
  promoted: unreachable,
}
const seeder = (): Promise<BoardRecord> => Promise.reject(new Error('not called'))
const boardCase = boardIsolationCase(api, seeder)

describe('board isolation case — contract shape (TASK-044)', () => {
  it('has the contract fields and the leaf route prefixes', () => {
    expect(boardCase.module).toBe('board')
    expect(boardCase.routePrefixes).toEqual(['/api/v1/boards', '/api/v1/cards'])
    for (const k of ['seed', 'read', 'write', 'fingerprint'] as const) expect(typeof boardCase[k], k).toBe('function')
    expect(boardCase.attempts.length).toBeGreaterThan(0)
    expect(boardCase.controls.length).toBeGreaterThan(0)
  })

  it('BOARD_ROUTE_KINDS names exactly the leaf route table (nine routes)', () => {
    expect([...BOARD_ROUTE_KINDS.keys()].sort()).toEqual(ROUTE_TABLE)
    expect(ROUTE_TABLE).toHaveLength(9)
  })

  it('every route has the attempt (or control) it needs, inside routePrefixes', () => {
    expect(validateCase(boardCase, BOARD_ROUTE_KINDS)).toEqual([])
  })

  it('covers every §3.3 vector: 1-8 and H as attempts, 9 and H as controls', () => {
    expect([...new Set(boardCase.attempts.map((a) => a.vector))].sort()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', 'H'])
    expect(boardCase.attempts.filter((a) => a.vector === 'H').map((a) => a.kind).sort()).toEqual(['read', 'write'])
    expect(boardCase.controls.map((c) => c.vector).sort()).toEqual(['9', 'H'])
  })

  it('the refusal cases (A3/A4/A8) call every route of the table', () => {
    expect(everyRouteCall().map((c) => c.route).sort()).toEqual(ROUTE_TABLE)
  })
})

describe('validateCase refuses an incomplete case', () => {
  const withAttempts = (attempts: readonly Attempt[]): IsolationCase<BoardRecord> => ({ ...boardCase, attempts })
  const withControls = (controls: readonly Control[]): IsolationCase<BoardRecord> => ({ ...boardCase, controls })

  it('a case whose attempts omit route 8 (POST /api/v1/boards/:id/stacks)', () => {
    const c = withAttempts(boardCase.attempts.filter((a) => a.route !== 'POST /api/v1/boards/:id/stacks'))
    expect(validateCase(c, BOARD_ROUTE_KINDS)).toContain('POST /api/v1/boards/:id/stacks has no write attempt')
  })

  it('a case whose controls omit vector 9 (POST /api/v1/boards)', () => {
    const c = withControls(boardCase.controls.filter((k) => k.vector !== '9'))
    expect(validateCase(c, BOARD_ROUTE_KINDS)).toContain('POST /api/v1/boards has no control')
  })

  it('a read route with only a write attempt, and a write route with only a read attempt', () => {
    const c = withAttempts([
      ...boardCase.attempts.filter((a) => a.route !== 'GET /api/v1/boards' && a.route !== 'PATCH /api/v1/cards/:id/move'),
      { ...boardCase.attempts.find((a) => a.route === 'GET /api/v1/boards')!, kind: 'write' },
      { ...boardCase.attempts.find((a) => a.route === 'PATCH /api/v1/cards/:id/move')!, kind: 'read' },
    ])
    const problems = validateCase(c, BOARD_ROUTE_KINDS)
    expect(problems).toContain('GET /api/v1/boards has no read attempt')
    expect(problems).toContain('PATCH /api/v1/cards/:id/move has no write attempt')
  })

  it('an attempt outside routePrefixes or on a route the leaf does not have', () => {
    const stray: Attempt = { vector: 'X', route: 'GET /api/v1/users', kind: 'read', what: 'stray', run: unreachable }
    const problems = validateCase(withAttempts([...boardCase.attempts, stray]), BOARD_ROUTE_KINDS)
    expect(problems).toContain('attempt X names GET /api/v1/users, which is not a leaf route')
    expect(problems).toContain('attempt X GET /api/v1/users is outside routePrefixes')
  })

  it('zero attempts', () => {
    expect(validateCase(withAttempts([]), BOARD_ROUTE_KINDS)).toContain('the case has zero attempts')
  })
})

// ── the harness's rules, on stub cases ──────────────────────────────────────

const rec = (t: TenantRef, canary: string): BoardRecord => ({
  tenant: t,
  orgUnitId: `ou-${t.slug}`,
  boardId: `board-${t.slug}`,
  stackIds: [`s1-${t.slug}`, `s2-${t.slug}`],
  cardId: `card-${t.slug}`,
  actionItemId: `ai-${t.slug}`,
  canary,
})

/** A stub case over an in-memory "store" with one counter per tenant (its fingerprint). */
function stubCase(opts: {
  readOwn?: (as: TenantRef) => ApiResult
  attempts?: Attempt[]
  controls?: Control[]
}): { c: IsolationCase<BoardRecord>; state: Map<string, number> } {
  const state = new Map<string, number>([
    [TENANT_A.id, 0],
    [TENANT_B.id, 0],
  ])
  const c: IsolationCase<BoardRecord> = {
    module: 'board',
    routePrefixes: ['/api/v1/boards', '/api/v1/cards'],
    seed: async (as) => rec(as, `canary-${as.slug}`),
    read: async (as, r) => opts.readOwn?.(as) ?? { status: 200, body: { canary: r.canary } },
    write: async (as) => {
      state.set(as.id, state.get(as.id)! + 1)
      return { status: 201, body: {} }
    },
    fingerprint: async (as) => String(state.get(as.id)),
    secrets: (r) => [r.canary, r.boardId, ...r.stackIds, r.cardId, r.actionItemId],
    canary: (r) => r.canary,
    attempts: opts.attempts ?? [],
    controls: opts.controls ?? [],
  }
  return { c, state }
}

const read = (run: () => ApiResult): Attempt => ({ vector: 'r', route: 'GET /api/v1/boards/:id', kind: 'read', what: 'stub read', run: async () => run() })

describe('runIsolation — controls first, harness-owned verdicts, vacuity', () => {
  const opts = { api, attacker: TENANT_A, victim: TENANT_B }

  it('a failed positive control aborts the run and judges no attempt', async () => {
    const { c } = stubCase({ readOwn: (as) => (as.id === TENANT_B.id ? { status: 404, body: {} } : { status: 200, body: { canary: 'canary-tenant-a' } }), attempts: [read(() => ({ status: 404, body: {} }))] })
    const r = await runIsolation(c, opts)
    expect(r.ok).toBe(false)
    expect(r.aborted).toMatch(/positive control failed/)
    expect(r.attempts).toEqual([])
  })

  it("A's own write must change A's fingerprint (a write control that changes nothing fails)", async () => {
    const { c } = stubCase({ attempts: [read(() => ({ status: 404, body: {} }))] })
    c.write = async () => ({ status: 201, body: {} })
    const r = await runIsolation(c, opts)
    expect(r.aborted).toMatch(/positive control failed/)
    expect(r.controls.find((x) => x.name === 'A writes its own record')?.ok).toBe(false)
  })

  it('zero attempts: the run is vacuous and fails', async () => {
    const r = await runIsolation(stubCase({}).c, opts)
    expect(r.ok).toBe(false)
    expect(r.aborted).toMatch(/zero attempts/)
  })

  it("a read fails on a 2xx carrying B's canary or one of B's ids, and passes on a 2xx without B data or a non-2xx", async () => {
    const { c } = stubCase({
      attempts: [
        read(() => ({ status: 200, body: { name: 'canary-tenant-b' } })),
        read(() => ({ status: 200, body: { data: ['ai-tenant-b'] } })),
        read(() => ({ status: 200, body: { data: [] } })),
        read(() => ({ status: 404, body: { name: 'canary-tenant-b' } })),
      ],
    })
    const r = await runIsolation(c, opts)
    expect(r.attempts.map((a) => a.passed)).toEqual([false, false, true, true])
    expect(r.ok).toBe(false)
  })

  it("a write fails on any 2xx, and on a non-2xx that still changed B's fingerprint", async () => {
    const { c, state } = stubCase({})
    c.attempts = [
      { vector: 'w', route: 'POST /api/v1/cards', kind: 'write', what: '2xx, no change', run: async () => ({ status: 201, body: {} }) },
      {
        vector: 'w',
        route: 'POST /api/v1/cards',
        kind: 'write',
        what: 'refused but B changed',
        run: async () => {
          state.set(TENANT_B.id, state.get(TENANT_B.id)! + 1)
          return { status: 404, body: {} }
        },
      },
      { vector: 'w', route: 'POST /api/v1/cards', kind: 'write', what: 'refused, nothing changed', run: async () => ({ status: 404, body: {} }) },
    ]
    const r = await runIsolation(c, opts)
    expect(r.attempts.map((a) => a.passed)).toEqual([false, false, true])
  })

  it('a clean case passes', async () => {
    const r = await runIsolation(stubCase({ attempts: [read(() => ({ status: 404, body: {} }))] }).c, opts)
    expect(r.ok).toBe(true)
    expect(r.controls.every((x) => x.ok)).toBe(true)
    expect(r.controls.length).toBe(3)
  })
})
