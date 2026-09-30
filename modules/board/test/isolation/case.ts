// modules/board/test/isolation/case.ts
//
// The board's two-tenant isolation case (R29-BOARD-STORE-K A7/A9), in TASK-044's
// contract shape {module, routePrefixes, seed(as), read(as,id), write(as,id),
// fingerprint(as,id)} plus the attempt rows of §3.3 (`attempts`) and the
// case-specific positive controls (`controls`). The transport is injected
// (BoardApi); only the leaf adapter ships here (leaf-api.ts). The harness
// (harness.ts) owns verdicts, the standard controls and vacuity.
import { createHash, randomUUID } from 'node:crypto'
import type { TenantRef } from '../../src/store/index.ts'
import type { ApiResult, BoardApi } from './api.ts'

/** One tenant's seeded board record: the "id" the contract's read/write/fingerprint take. */
export interface BoardRecord {
  tenant: TenantRef
  orgUnitId: string
  boardId: string
  stackIds: readonly [string, string]
  cardId: string
  actionItemId: string
  /** A random title per run, carried by the board name, the card and the promoted card. */
  canary: string
}

/** Seeds one tenant's record. The leaf suites seed through app.storeFor(tenant). */
export type Seeder = (as: TenantRef) => Promise<BoardRecord>

export interface AttemptContext {
  api: BoardApi
  /** Tenant A. */
  attacker: TenantRef
  /** A's own record. */
  own: BoardRecord
  /** B's record: the target. */
  victim: BoardRecord
}

export interface Attempt {
  /** §3.3 vector: '1'..'8' or 'H'. */
  vector: string
  /** The leaf route, as the route table spells it: `<METHOD> <path>`. */
  route: string
  kind: 'read' | 'write'
  what: string
  /** Write only: A's own fingerprint must not change either (vector 6, A's card into B's stack). */
  ownUnchanged?: boolean
  run(ctx: AttemptContext): Promise<ApiResult>
}

export interface ControlContext extends AttemptContext {
  fingerprint(as: TenantRef, rec: BoardRecord): Promise<string>
}

export interface ControlOutcome {
  ok: boolean
  detail: string
}

export interface Control {
  vector: string
  route: string
  what: string
  run(ctx: ControlContext): Promise<ControlOutcome>
}

export interface IsolationCase<R> {
  module: string
  routePrefixes: readonly string[]
  seed(as: TenantRef): Promise<R>
  read(as: TenantRef, rec: R): Promise<ApiResult>
  write(as: TenantRef, rec: R): Promise<ApiResult>
  fingerprint(as: TenantRef, rec: R): Promise<string>
  /** The record's data a leaked read would carry: its canary and its row ids. */
  secrets(rec: R): readonly string[]
  canary(rec: R): string
  attempts: readonly Attempt[]
  controls: readonly Control[]
}

export const is2xx = (r: ApiResult): boolean => r.status >= 200 && r.status < 300

function byId<T extends { id?: unknown }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

function expect2xx(r: ApiResult, what: string): ApiResult {
  if (!is2xx(r)) throw new Error(`[board-case] fingerprint read ${what} answered ${r.status}: ${JSON.stringify(r.body)}`)
  return r
}

/** as mixes one tenant's id with another tenant's slug (vector H). */
export function forgedSlug(id: TenantRef, slugOf: TenantRef): TenantRef {
  return { id: id.id, slug: slugOf.slug }
}

/** §3.3 attempt rows. */
export function boardAttempts(): Attempt[] {
  return [
    {
      vector: '1',
      route: 'GET /api/v1/boards',
      kind: 'read',
      what: "list B's org unit",
      run: ({ api, attacker, victim }) => api.listBoards(attacker, [victim.orgUnitId]),
    },
    {
      vector: '2',
      route: 'GET /api/v1/boards/:id',
      kind: 'read',
      what: "B's board by id",
      run: ({ api, attacker, victim }) => api.getBoard(attacker, victim.boardId),
    },
    {
      vector: '3',
      route: 'GET /api/v1/boards/:id/deck',
      kind: 'read',
      what: "B's deck",
      run: ({ api, attacker, victim }) => api.deck(attacker, victim.boardId),
    },
    {
      vector: '4',
      route: 'POST /api/v1/cards/promoted',
      kind: 'read',
      what: "existence oracle on B's promoted action item",
      run: ({ api, attacker, victim }) => api.promoted(attacker, [victim.actionItemId]),
    },
    {
      vector: '5',
      route: 'POST /api/v1/cards',
      kind: 'write',
      what: "a card into B's stack",
      run: ({ api, attacker, victim }) =>
        api.createCard(attacker, { stackId: victim.stackIds[0], title: 'intrusion-5', createdBy: 'attacker' }),
    },
    {
      vector: '6',
      route: 'PATCH /api/v1/cards/:id/move',
      kind: 'write',
      what: "B's card into B's other stack",
      run: ({ api, attacker, victim }) => api.moveCard(attacker, victim.cardId, { stackId: victim.stackIds[1], order: 0 }),
    },
    {
      vector: '6',
      route: 'PATCH /api/v1/cards/:id/move',
      kind: 'write',
      what: "A's own card into B's stack",
      ownUnchanged: true,
      run: ({ api, attacker, own, victim }) => api.moveCard(attacker, own.cardId, { stackId: victim.stackIds[1], order: 0 }),
    },
    {
      vector: '7',
      route: 'POST /api/v1/boards/:id/promote',
      kind: 'write',
      what: "promote an action item onto B's board",
      run: ({ api, attacker, victim }) =>
        api.promote(attacker, victim.boardId, {
          item: { id: randomUUID(), text: 'intrusion-7', assigneeKeycloakId: null, dueDate: null },
          createdBy: 'attacker',
        }),
    },
    {
      vector: 'H',
      route: 'GET /api/v1/boards/:id/deck',
      kind: 'read',
      what: "B's deck with x-tenant-id = A and x-tenant-slug = B's slug",
      run: ({ api, attacker, victim }) => api.deck(forgedSlug(attacker, victim.tenant), victim.boardId),
    },
    {
      vector: 'H',
      route: 'POST /api/v1/cards',
      kind: 'write',
      what: "a card into B's stack with x-tenant-id = A and x-tenant-slug = B's slug",
      run: ({ api, attacker, victim }) =>
        api.createCard(forgedSlug(attacker, victim.tenant), { stackId: victim.stackIds[0], title: 'intrusion-H', createdBy: 'attacker' }),
    },
  ]
}

/** Case-specific positive controls. */
export function boardControls(): Control[] {
  return [
    {
      vector: 'H',
      route: 'GET /api/v1/boards/:id/deck',
      what: "A's own deck with x-tenant-slug = B's slug answers A's data",
      async run({ api, attacker, own, victim }) {
        const r = await api.deck(forgedSlug(attacker, victim.tenant), own.boardId)
        const body = JSON.stringify(r.body)
        const ok = is2xx(r) && body.includes(own.canary) && !body.includes(victim.canary)
        return { ok, detail: `${r.status} ${ok ? "carries A's canary only" : body.slice(0, 200)}` }
      },
    },
  ]
}

export function boardIsolationCase(api: BoardApi, seeder: Seeder): IsolationCase<BoardRecord> {
  return {
    module: 'board',
    routePrefixes: ['/api/v1/boards', '/api/v1/cards'],
    seed: (as) => seeder(as),
    // TASK-044's single read and write: vector 3 (deck) and vector 5 (card into a stack).
    read: (as, rec) => api.deck(as, rec.boardId),
    write: (as, rec) => api.createCard(as, { stackId: rec.stackIds[0], title: `write-${randomUUID()}`, createdBy: 'case' }),
    async fingerprint(as, rec) {
      const list = expect2xx(await api.listBoards(as, [rec.orgUnitId]), 'list')
      const boards = byId((list.body as { data: { id: string }[] }).data)
      const decks: unknown[] = []
      for (const b of boards) {
        const d = expect2xx(await api.deck(as, b.id), `deck ${b.id}`).body as { board: unknown; stacks: { id: string }[]; cards: { id: string }[] }
        decks.push({ board: d.board, stacks: byId(d.stacks), cards: byId(d.cards) })
      }
      const promoted = expect2xx(await api.promoted(as, [rec.actionItemId]), 'promoted').body
      return createHash('sha256').update(JSON.stringify({ boards, decks, promoted })).digest('hex')
    },
    secrets: (rec) => [rec.canary, rec.boardId, ...rec.stackIds, rec.cardId, rec.actionItemId],
    canary: (rec) => rec.canary,
    attempts: boardAttempts(),
    controls: boardControls(),
  }
}
