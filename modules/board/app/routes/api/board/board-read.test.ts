import { describe, it, expect, vi } from 'vitest'

vi.mock('$lib/server/board/scope', () => ({ resolveBoardOrgUnitScope: vi.fn(async () => ['ou-1']) }))
vi.mock('$lib/server/board/board-db', () => ({
  boardDb: {
    listBoardsForOrgUnits: vi.fn(async () => [{ id: 'b1', org_unit_id: 'ou-1', name: 'StuRa', archived: false }]),
    getBoard: vi.fn(async () => ({ id: 'b1', org_unit_id: 'ou-1', name: 'StuRa', archived: false })),
    deckFor: vi.fn(async () => ({ board: { id: 'b1', org_unit_id: 'ou-1', name: 'StuRa', archived: false }, stacks: [], cards: [] })),
  },
}))
import { GET as listBoards } from './+server'
import { GET as getDeck } from './[id]/+server'

const member = { auth: async () => ({ user: { id: 'u1', roles: ['member'] } }) } as any

describe('board read API', () => {
  it('lists boards the user can see', async () => {
    const res = await listBoards({ locals: member } as any)
    const body = await res.json()
    expect(body.data[0].id).toBe('b1')
  })

  it('403s a deck the user is not scoped to', async () => {
    const scope = await import('$lib/server/board/scope')
    ;(scope.resolveBoardOrgUnitScope as any).mockResolvedValueOnce([]) // scoped to nothing
    await expect(getDeck({ params: { id: 'b1' }, locals: member } as any)).rejects.toMatchObject({ status: 403 })
  })
})
