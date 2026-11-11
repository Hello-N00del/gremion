import { describe, it, expect, vi, beforeEach } from 'vitest'

const OU_A = '11111111-1111-4111-8111-111111111111'
const OU_B = '22222222-2222-4222-8222-222222222222'
const OU_C = '33333333-3333-4333-8333-333333333333'

const { listBoardsForOrgUnits, resolveScope, listOrgUnits } = vi.hoisted(() => ({
  listBoardsForOrgUnits: vi.fn(),
  resolveScope: vi.fn(),
  listOrgUnits: vi.fn(),
}))
vi.mock('$lib/server/board/scope', () => ({ resolveBoardOrgUnitScope: resolveScope }))
vi.mock('$lib/server/board/backend/resolve', () => ({
  resolveBoardBackendForPage: () => ({
    listBoardsForOrgUnits,
    deckFor: vi.fn(async () => ({ board: {}, stacks: [], cards: [] })),
  }),
}))
vi.mock('$lib/server/governance/org-units-db', () => ({ listOrgUnits }))
vi.mock('$lib/server/identity/display-names', () => ({
  getDisplayNameResolver: () => ({ resolveMany: async () => new Map() }),
}))
import { load } from './+page.server'

const member = { auth: async () => ({ user: { id: 'u1', roles: ['member'] } }) } as any
const run = () => load({ locals: member, url: new URL('http://x/tasks') } as any) as Promise<any>

describe('/tasks load — creatable units', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
