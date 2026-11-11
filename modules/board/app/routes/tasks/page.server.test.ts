import { describe, it, expect, vi, beforeEach } from 'vitest'

const OU_A = '11111111-1111-4111-8111-111111111111'
const OU_B = '22222222-2222-4222-8222-222222222222'
const OU_C = '33333333-3333-4333-8333-333333333333'

const { listBoardsForOrgUnits, resolveScope, listOrgUnits, listOrgUnitMembers, deckFor, resolveMany } = vi.hoisted(() => ({
  listBoardsForOrgUnits: vi.fn(),
  resolveScope: vi.fn(),
  listOrgUnits: vi.fn(),
  listOrgUnitMembers: vi.fn(),
  deckFor: vi.fn(),
  resolveMany: vi.fn(),
}))
vi.mock('$lib/server/board/scope', () => ({ resolveBoardOrgUnitScope: resolveScope }))
vi.mock('$lib/server/board/backend/resolve', () => ({
  resolveBoardBackendForPage: () => ({
    listBoardsForOrgUnits,
    deckFor,
  }),
}))
vi.mock('$lib/server/governance/org-units-db', () => ({ listOrgUnits, listOrgUnitMembers }))
vi.mock('$lib/server/identity/display-names', () => ({
  getDisplayNameResolver: () => ({ resolveMany }),
}))
import { load } from './+page.server'

const member = { auth: async () => ({ user: { id: 'u1', roles: ['member'] } }) } as any
const run = () => load({ locals: member, url: new URL('http://x/tasks') } as any) as Promise<any>

describe('/tasks load — creatable units', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deckFor.mockResolvedValue({ board: {}, stacks: [], cards: [] })
    listOrgUnitMembers.mockResolvedValue([])
    resolveMany.mockResolvedValue(new Map())
    listOrgUnits.mockResolvedValue([
      { id: OU_A, name: 'StuRa' },
      { id: OU_B, name: 'Vorstand' },
      { id: OU_C, name: 'Fremdes Gremium' },
    ])
    resolveScope.mockResolvedValue([OU_A, OU_B])
  })

  it('lists in-scope units with no live board, as {id, name} only', async () => {
    listBoardsForOrgUnits.mockResolvedValue([])
    const data = await run()
    expect(data.creatable).toEqual([
      { id: OU_A, name: 'StuRa' },
      { id: OU_B, name: 'Vorstand' },
    ])
  })

  it('never returns units outside the scope', async () => {
    listBoardsForOrgUnits.mockResolvedValue([])
    const data = await run()
    expect(data.creatable.map((u: any) => u.id)).not.toContain(OU_C)
  })

  it('omits units that already have a non-archived board but keeps archived-only ones', async () => {
    listBoardsForOrgUnits.mockResolvedValue([
      { id: 'b1', org_unit_id: OU_A, name: 'Aufgaben', archived: false },
      { id: 'b2', org_unit_id: OU_B, name: 'Alt', archived: true },
    ])
    const data = await run()
    expect(data.creatable).toEqual([{ id: OU_B, name: 'Vorstand' }])
  })

  it('is empty when the user belongs to no body', async () => {
    resolveScope.mockResolvedValue([])
    listBoardsForOrgUnits.mockResolvedValue([])
    const data = await run()
    expect(data.creatable).toEqual([])
  })
})

// The card editor offers the members of the board's own committee as assignees. The picker needs
// their ids as option values; nothing outside that committee leaves the server.
const U_ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const U_BERT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const U_GONE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

describe('/tasks load — members for the card editor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listOrgUnits.mockResolvedValue([{ id: OU_A, name: 'StuRa' }])
    resolveScope.mockResolvedValue([OU_A])
    listBoardsForOrgUnits.mockResolvedValue([{ id: 'b1', org_unit_id: OU_A, name: 'Aufgaben', archived: false }])
    listOrgUnitMembers.mockResolvedValue([{ user_keycloak_id: U_BERT }, { user_keycloak_id: U_ANNA }])
    resolveMany.mockResolvedValue(new Map([[U_ANNA, 'Anna Adler'], [U_BERT, 'Bert Berg'], [U_GONE, 'Gerda Gegangen']]))
    deckFor.mockResolvedValue({
      board: { id: 'b1', org_unit_id: OU_A, name: 'Aufgaben', archived: false },
      stacks: [{ id: 's1', name: 'To Do', sort_order: 0 }],
      cards: [
        { id: 'c1', stack_id: 's1', title: 'A', assignee_keycloak_id: U_ANNA, due_date: null },
        { id: 'c2', stack_id: 's1', title: 'B', assignee_keycloak_id: U_GONE, due_date: null },
        { id: 'c3', stack_id: 's1', title: 'C', assignee_keycloak_id: null, due_date: null },
      ],
    })
  })

  it("lists the members of the selected board's committee, sorted by name, as {id, name}", async () => {
    const data = await run()
    expect(listOrgUnitMembers).toHaveBeenCalledWith(OU_A)
    expect(data.members).toEqual([
      { id: U_ANNA, name: 'Anna Adler' },
      { id: U_BERT, name: 'Bert Berg' },
    ])
  })

  it('is empty when no board is selected', async () => {
    listBoardsForOrgUnits.mockResolvedValue([])
    const data = await run()
    expect(data.members).toEqual([])
    expect(listOrgUnitMembers).not.toHaveBeenCalled()
  })

  it("marks a card's assignee for the picker only while that person is still a member", async () => {
    const data = await run()
    const byId = Object.fromEntries(data.deck.cards.map((c: any) => [c.id, c]))
    expect(byId.c1.assignee_id).toBe(U_ANNA)
    // left the committee: the name still shows on the card, the picker has nothing to preselect
    expect(byId.c2.assignee_name).toBe('Gerda Gegangen')
    expect(byId.c2.assignee_id).toBeNull()
    expect(byId.c3.assignee_id).toBeNull()
  })

  it('never returns the raw assignee column', async () => {
    const data = await run()
    for (const c of data.deck.cards) expect(c).not.toHaveProperty('assignee_keycloak_id')
  })
})
