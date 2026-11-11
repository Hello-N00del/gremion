import { describe, it, expect, vi, beforeEach } from 'vitest'

const OU = '11111111-1111-4111-8111-111111111111'
const OU_FOREIGN = '22222222-2222-4222-8222-222222222222'

const { listBoardsForOrgUnits, createBoardWithStacks, resolveScope } = vi.hoisted(() => ({
  listBoardsForOrgUnits: vi.fn(),
  createBoardWithStacks: vi.fn(),
  resolveScope: vi.fn(),
}))
vi.mock('$lib/server/board/scope', () => ({ resolveBoardOrgUnitScope: resolveScope }))
vi.mock('$lib/server/board/board-db', () => ({
  boardDb: { listBoardsForOrgUnits, createBoardWithStacks },
}))
import { POST } from './+server'

const member = { auth: async () => ({ user: { id: 'u1', roles: ['member'] } }) } as any
const anon = { auth: async () => null } as any
const post = (body: unknown, locals = member) =>
  POST({
    request: new Request('http://x', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    locals,
  } as any)

describe('POST /api/board — a body member creates the body board', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveScope.mockResolvedValue([OU])
    listBoardsForOrgUnits.mockResolvedValue([])
    createBoardWithStacks.mockImplementation(async (input: any) => ({
      board: { id: 'b-new', org_unit_id: input.orgUnitId, name: input.name, archived: false, created_at: new Date() },
      stacks: [],
    }))
  })

  it('creates "Aufgaben" with the three stacks and returns 201 + id', async () => {
    const res = await post({ orgUnitId: OU })
    expect(res.status).toBe(201)
    expect((await res.json()).data.id).toBe('b-new')
    expect(createBoardWithStacks).toHaveBeenCalledWith({
      orgUnitId: OU,
      name: 'Aufgaben',
      stacks: ['Offen', 'In Arbeit', 'Erledigt'],
    })
  })

  it('rejects a body that is not a uuid (400) and creates nothing', async () => {
    await expect(post({ orgUnitId: 'nope' })).rejects.toMatchObject({ status: 400 })
    await expect(post({})).rejects.toMatchObject({ status: 400 })
    await expect(post('not json')).rejects.toMatchObject({ status: 400 })
    expect(createBoardWithStacks).not.toHaveBeenCalled()
  })

  it('denies a unit outside the user scope (403) and creates nothing', async () => {
    await expect(post({ orgUnitId: OU_FOREIGN })).rejects.toMatchObject({ status: 403 })
    expect(createBoardWithStacks).not.toHaveBeenCalled()
  })

  it('denies an anonymous caller (403)', async () => {
    await expect(post({ orgUnitId: OU }, anon)).rejects.toMatchObject({ status: 403 })
    expect(createBoardWithStacks).not.toHaveBeenCalled()
  })

  it('answers 409 with the existing board id when a live board exists', async () => {
    listBoardsForOrgUnits.mockResolvedValue([{ id: 'b-old', org_unit_id: OU, name: 'StuRa', archived: false }])
    const res = await post({ orgUnitId: OU })
    expect(res.status).toBe(409)
    expect((await res.json()).data.id).toBe('b-old')
    expect(createBoardWithStacks).not.toHaveBeenCalled()
  })

  it('an archived board does not block creating a new one', async () => {
    listBoardsForOrgUnits.mockResolvedValue([{ id: 'b-arch', org_unit_id: OU, name: 'Alt', archived: true }])
    const res = await post({ orgUnitId: OU })
    expect(res.status).toBe(201)
  })
})
