import { describe, it, expect, vi } from 'vitest'

vi.mock('$lib/server/board/scope', () => ({ resolveBoardOrgUnitScope: vi.fn(async () => ['ou-1']) }))
vi.mock('$lib/server/board/board-db', () => ({
  boardDb: {
    getBoard: vi.fn(async () => ({ id: 'b1', org_unit_id: 'ou-1', name: 'StuRa', archived: false })),
    // R29-BOARD-STORE-S B12: the handlers check stackId/cardId against the board's deck.
    deckFor: vi.fn(async () => ({
      board: { id: 'b1', org_unit_id: 'ou-1', name: 'StuRa', archived: false },
      stacks: [{ id: 's1', board_id: 'b1', name: 'To Do', sort_order: 0 }, { id: 's2', board_id: 'b1', name: 'Done', sort_order: 1 }],
      cards: [{ id: 'c1', stack_id: 's1' }],
    })),
    createCard: vi.fn(async (d: any) => ({ id: 'c1', ...d })),
    moveCard: vi.fn(async (id: string, to: any) => ({ id, stack_id: to.stackId, sort_order: to.order })),
  },
}))
import { POST as createCard, PATCH as moveCard } from './[id]/cards/+server'

const member = { auth: async () => ({ user: { id: 'u1', roles: ['member'] } }) } as any

describe('board write API', () => {
  it('creates a card on a board the user can write', async () => {
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ stackId: 's1', title: 'Neu' }) })
    const res = await createCard({ params: { id: 'b1' }, request: req, locals: member } as any)
    expect(res.status).toBe(201)
  })

  it('rejects a card create with no title (400)', async () => {
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ stackId: 's1' }) })
    await expect(createCard({ params: { id: 'b1' }, request: req, locals: member } as any)).rejects.toMatchObject({ status: 400 })
  })

  it('denies create on a board outside the user scope (403)', async () => {
    const scope = await import('$lib/server/board/scope')
    ;(scope.resolveBoardOrgUnitScope as any).mockResolvedValueOnce([]) // scoped to nothing
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ stackId: 's1', title: 'Neu' }) })
    await expect(createCard({ params: { id: 'b1' }, request: req, locals: member } as any)).rejects.toMatchObject({ status: 403 })
  })

  it('moves a card', async () => {
    const req = new Request('http://x', { method: 'PATCH', body: JSON.stringify({ cardId: 'c1', stackId: 's2', order: 0 }) })
    const res = await moveCard({ params: { id: 'b1' }, request: req, locals: member } as any)
    const body = await res.json()
    expect(body.data.stack_id).toBe('s2')
  })
})
