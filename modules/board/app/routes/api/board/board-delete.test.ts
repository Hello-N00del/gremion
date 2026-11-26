import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// Same arrangement as board-update.test.ts: the routes run through the in-process client.
vi.stubEnv('BOARD_BACKEND', 'inprocess')
afterAll(() => vi.unstubAllEnvs())

const OU = 'ou-1'

const { deleteCard, deckFor, resolveScope } = vi.hoisted(() => ({
  deleteCard: vi.fn(),
  deckFor: vi.fn(),
  resolveScope: vi.fn(),
}))

vi.mock('$lib/server/board/scope', () => ({ resolveBoardOrgUnitScope: resolveScope }))
vi.mock('$lib/server/governance/org-units-db', () => ({ isMemberOf: vi.fn() }))
vi.mock('$lib/server/board/board-db', () => ({
  boardDb: {
    getBoard: vi.fn(async (id: string) => (id === 'b1' ? { id: 'b1', org_unit_id: OU, name: 'StuRa', archived: false } : null)),
    deckFor,
    deleteCard,
  },
}))
import { DELETE } from './[id]/cards/+server'

const member = { auth: async () => ({ user: { id: 'u1', roles: ['member'] } }) } as any
const guest = { auth: async () => ({ user: { id: 'u9', roles: [] } }) } as any

const del = (query: string, locals: any = member, boardId = 'b1') =>
  DELETE({
    params: { id: boardId },
    url: new URL(`http://x/api/board/${boardId}/cards${query}`),
    request: new Request('http://x', { method: 'DELETE' }),
    locals,
  } as any)

describe('board card delete (DELETE /api/board/[id]/cards?cardId=)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveScope.mockResolvedValue([OU])
    deckFor.mockResolvedValue({
      board: { id: 'b1', org_unit_id: OU, name: 'StuRa', archived: false },
      stacks: [{ id: 's1', board_id: 'b1', name: 'To Do', sort_order: 0 }],
      cards: [{ id: 'c1', stack_id: 's1' }],
    })
    deleteCard.mockResolvedValue(true)
  })

  it('deletes a card of the board for a member of its committee', async () => {
    const res = await del('?cardId=c1')
    expect(res.status).toBe(200)
    expect(deleteCard).toHaveBeenCalledWith('c1')
    expect((await res.json()).data).toEqual({ id: 'c1', deleted: true })
  })

  it('refuses someone who is no member at all, and deletes nothing', async () => {
    await expect(del('?cardId=c1', guest)).rejects.toMatchObject({ status: 403 })
    expect(deleteCard).not.toHaveBeenCalled()
  })

  it('refuses a board outside the caller\'s units, and deletes nothing', async () => {
    resolveScope.mockResolvedValue(['other-unit'])
    await expect(del('?cardId=c1')).rejects.toMatchObject({ status: 403 })
    expect(deleteCard).not.toHaveBeenCalled()
  })

  it('answers 404 for a card of another board, and deletes nothing', async () => {
    await expect(del('?cardId=c-other')).rejects.toMatchObject({ status: 404 })
    expect(deleteCard).not.toHaveBeenCalled()
  })

  it('answers 400 without a card id, and deletes nothing', async () => {
    await expect(del('')).rejects.toMatchObject({ status: 400 })
    expect(deleteCard).not.toHaveBeenCalled()
  })

  it('answers 404 when the card vanished between the check and the delete', async () => {
    deleteCard.mockResolvedValue(false)
    await expect(del('?cardId=c1')).rejects.toMatchObject({ status: 404 })
  })
})
