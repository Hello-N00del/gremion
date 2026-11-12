import { describe, it, expect, vi, beforeEach } from 'vitest'

const OU = 'ou-1'
const MEMBER_ID = '11111111-1111-4111-8111-111111111111'
const STRANGER_ID = '22222222-2222-4222-8222-222222222222'

const { createCard, updateCard, moveCard, deckFor, resolveScope, isMemberOf } = vi.hoisted(() => ({
  createCard: vi.fn(),
  updateCard: vi.fn(),
  moveCard: vi.fn(),
  deckFor: vi.fn(),
  resolveScope: vi.fn(),
  isMemberOf: vi.fn(),
}))

vi.mock('$lib/server/board/scope', () => ({ resolveBoardOrgUnitScope: resolveScope }))
vi.mock('$lib/server/governance/org-units-db', () => ({ isMemberOf }))
vi.mock('$lib/server/board/board-db', () => ({
  boardDb: {
    getBoard: vi.fn(async () => ({ id: 'b1', org_unit_id: OU, name: 'StuRa', archived: false })),
    deckFor,
    createCard,
    updateCard,
    moveCard,
  },
}))
import { PATCH, POST } from './[id]/cards/+server'

const member = { auth: async () => ({ user: { id: 'u1', roles: ['member'] } }) } as any
const guest = { auth: async () => ({ user: { id: 'u9', roles: [] } }) } as any

const patch = (body: unknown, locals: any = member, boardId = 'b1') =>
  PATCH({
    params: { id: boardId },
    request: new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }),
    locals,
  } as any)

describe('board card edit (PATCH without a stack)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveScope.mockResolvedValue([OU])
    isMemberOf.mockImplementation(async (_ou: string, id: string) => id === MEMBER_ID)
    deckFor.mockResolvedValue({
      board: { id: 'b1', org_unit_id: OU, name: 'StuRa', archived: false },
      stacks: [{ id: 's1', board_id: 'b1', name: 'To Do', sort_order: 0 }],
      cards: [{ id: 'c1', stack_id: 's1' }],
    })
    updateCard.mockImplementation(async (id: string, p: any) => ({ id, stack_id: 's1', ...p }))
    moveCard.mockImplementation(async (id: string, to: any) => ({ id, stack_id: to.stackId, sort_order: to.order }))
  })

  it('saves title, description and due date and answers the card', async () => {
    const res = await patch({ cardId: 'c1', title: ' Neuer Titel ', description: 'Text', dueDate: '2026-12-01' })
    expect(res.status).toBe(200)
    expect(updateCard).toHaveBeenCalledWith('c1', { title: 'Neuer Titel', description: 'Text', dueDate: '2026-12-01' })
    expect((await res.json()).data.title).toBe('Neuer Titel')
    expect(moveCard).not.toHaveBeenCalled()
  })

  it('stores an emptied description as null, so it is cleared and not saved as an empty string', async () => {
    await patch({ cardId: 'c1', description: '   ' })
    expect(updateCard).toHaveBeenCalledWith('c1', { description: null })
  })

  it('assigns a member of the board\'s committee', async () => {
    const res = await patch({ cardId: 'c1', assigneeKeycloakId: MEMBER_ID })
    expect(res.status).toBe(200)
    expect(isMemberOf).toHaveBeenCalledWith(OU, MEMBER_ID)
    expect(updateCard).toHaveBeenCalledWith('c1', { assigneeKeycloakId: MEMBER_ID })
  })

  it('refuses an assignee who is not a member of the committee, and changes nothing', async () => {
    await expect(patch({ cardId: 'c1', title: 'x', assigneeKeycloakId: STRANGER_ID })).rejects.toMatchObject({ status: 400 })
    expect(isMemberOf).toHaveBeenCalledWith(OU, STRANGER_ID)
    expect(updateCard).not.toHaveBeenCalled()
  })

  it('refuses an assignee that is no user id at all', async () => {
    await expect(patch({ cardId: 'c1', assigneeKeycloakId: 'not-a-uuid' })).rejects.toMatchObject({ status: 400 })
    expect(updateCard).not.toHaveBeenCalled()
  })

  it('clears the assignee with null, without a membership lookup', async () => {
    const res = await patch({ cardId: 'c1', assigneeKeycloakId: null })
    expect(res.status).toBe(200)
    expect(isMemberOf).not.toHaveBeenCalled()
    expect(updateCard).toHaveBeenCalledWith('c1', { assigneeKeycloakId: null })
  })

  it('answers 404 for a card that is not on this board, and never edits it', async () => {
    await expect(patch({ cardId: 'c-other-board', title: 'x' })).rejects.toMatchObject({ status: 404 })
    expect(updateCard).not.toHaveBeenCalled()
  })

  it('applies the same gate as a move: a board outside the user scope is 403', async () => {
    resolveScope.mockResolvedValueOnce(['another-ou'])
    await expect(patch({ cardId: 'c1', title: 'x' })).rejects.toMatchObject({ status: 403 })
    expect(updateCard).not.toHaveBeenCalled()
  })

  it('applies the same gate as a move: a caller without the member role is 403', async () => {
    await expect(patch({ cardId: 'c1', title: 'x' }, guest)).rejects.toMatchObject({ status: 403 })
    expect(updateCard).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty title', { cardId: 'c1', title: '  ' }],
    ['a title over 200 characters', { cardId: 'c1', title: 'x'.repeat(201) }],
    ['a due date in the German display format', { cardId: 'c1', dueDate: '01.12.2026' }],
    ['a day that does not exist', { cardId: 'c1', dueDate: '2026-02-30' }],
    ['no field to change', { cardId: 'c1' }],
    ['no card id', { title: 'x' }],
  ])('refuses %s with 400', async (_name, body) => {
    await expect(patch(body)).rejects.toMatchObject({ status: 400 })
    expect(updateCard).not.toHaveBeenCalled()
  })

  it('still moves a card when the body names a stack (the drag path is unchanged)', async () => {
    const res = await patch({ cardId: 'c1', stackId: 's1', order: 2 })
    expect(res.status).toBe(200)
    expect(moveCard).toHaveBeenCalledWith('c1', { stackId: 's1', order: 2 })
    expect(updateCard).not.toHaveBeenCalled()
  })

  it('passes only the fields the caller named to the backend (no undefined keys)', async () => {
    await patch({ cardId: 'c1', title: 'Nur Titel' })
    expect(Object.keys(updateCard.mock.calls[0][1])).toEqual(['title'])
  })
})

// Creating a card obeys the same assignee rule as editing one: a member of the board's own committee.
describe('board card create (POST) assignee rule', () => {
  const post = (body: unknown) =>
    POST({
      params: { id: 'b1' },
      request: new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
      locals: member,
    } as any)

  beforeEach(() => {
    vi.clearAllMocks()
    resolveScope.mockResolvedValue([OU])
    isMemberOf.mockImplementation(async (_ou: string, id: string) => id === MEMBER_ID)
    deckFor.mockResolvedValue({
      board: { id: 'b1', org_unit_id: OU, name: 'StuRa', archived: false },
      stacks: [{ id: 's1', board_id: 'b1', name: 'To Do', sort_order: 0 }],
      cards: [],
    })
    createCard.mockImplementation(async (d: any) => ({ id: 'new', ...d }))
  })

  it('creates a card assigned to a member of the committee', async () => {
    const res = await post({ stackId: 's1', title: 'A', assigneeKeycloakId: MEMBER_ID })
    expect(res.status).toBe(201)
    expect(isMemberOf).toHaveBeenCalledWith(OU, MEMBER_ID)
    expect(createCard).toHaveBeenCalled()
  })

  it('refuses an assignee who is not a member of the committee, and creates nothing', async () => {
    await expect(post({ stackId: 's1', title: 'A', assigneeKeycloakId: STRANGER_ID })).rejects.toMatchObject({ status: 400 })
    expect(createCard).not.toHaveBeenCalled()
  })

  it('refuses an assignee that is no user id at all', async () => {
    await expect(post({ stackId: 's1', title: 'A', assigneeKeycloakId: 'not-a-uuid' })).rejects.toMatchObject({ status: 400 })
    expect(createCard).not.toHaveBeenCalled()
  })

  it('creates an unassigned card without a membership lookup', async () => {
    const res = await post({ stackId: 's1', title: 'A' })
    expect(res.status).toBe(201)
    expect(isMemberOf).not.toHaveBeenCalled()
  })
})
