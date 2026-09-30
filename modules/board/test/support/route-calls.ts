// modules/board/test/support/route-calls.ts
//
// One well-formed request per leaf route (valid body, well-formed ids), for the
// cases that assert a tenant-level refusal on EVERY route: unprovisioned (A3),
// schema behind (A4) and the no-sleep request after disable (A8). A body that
// fails validation would answer 400 before the tenant's database is consulted,
// so every body here is valid.
import { randomUUID } from 'node:crypto'

export interface RouteCall {
  /** As the route table spells it. */
  route: string
  method: string
  path: string
  body?: unknown
}

export function everyRouteCall(ids: { orgUnitId?: string; boardId?: string; stackId?: string; cardId?: string } = {}): RouteCall[] {
  const orgUnitId = ids.orgUnitId ?? randomUUID()
  const boardId = ids.boardId ?? randomUUID()
  const stackId = ids.stackId ?? randomUUID()
  const cardId = ids.cardId ?? randomUUID()
  return [
    { route: 'GET /api/v1/boards', method: 'GET', path: `/api/v1/boards?orgUnitId=${orgUnitId}` },
    { route: 'POST /api/v1/boards', method: 'POST', path: '/api/v1/boards', body: { orgUnitId, name: 'route-call', stacks: ['To Do'] } },
    { route: 'GET /api/v1/boards/:id', method: 'GET', path: `/api/v1/boards/${boardId}` },
    { route: 'GET /api/v1/boards/:id/deck', method: 'GET', path: `/api/v1/boards/${boardId}/deck` },
    { route: 'POST /api/v1/boards/:id/stacks', method: 'POST', path: `/api/v1/boards/${boardId}/stacks`, body: { name: 'route-call', order: 0 } },
    { route: 'POST /api/v1/cards', method: 'POST', path: '/api/v1/cards', body: { stackId, title: 'route-call', createdBy: 'route-call' } },
    { route: 'PATCH /api/v1/cards/:id/move', method: 'PATCH', path: `/api/v1/cards/${cardId}/move`, body: { stackId, order: 0 } },
    { route: 'POST /api/v1/cards/promoted', method: 'POST', path: '/api/v1/cards/promoted', body: { candidateIds: [randomUUID()] } },
    {
      route: 'POST /api/v1/boards/:id/promote',
      method: 'POST',
      path: `/api/v1/boards/${boardId}/promote`,
      body: { item: { id: randomUUID(), text: 'route-call', assigneeKeycloakId: null, dueDate: null }, createdBy: 'route-call' },
    },
  ]
}
