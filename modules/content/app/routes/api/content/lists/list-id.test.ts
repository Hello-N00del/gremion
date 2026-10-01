import { beforeEach, describe, expect, it, vi } from 'vitest'

// F1-FIX-07 H08 (K5#27): the mailing-list [id] routes 404 any non-UUID id
// (SvelteKit hands routes DECODED params, so `..%2Fx` arrives as `../x`) BEFORE a
// backend call; a UUID still reaches the backend unchanged.

const { mockComposeCapabilities, mockDeleteList, mockAddMember, mockRemoveMember } = vi.hoisted(
  () => ({
    mockComposeCapabilities: vi.fn(),
    mockDeleteList: vi.fn(),
    mockAddMember: vi.fn(),
    mockRemoveMember: vi.fn(),
  }),
)

vi.mock('$lib/auth', () => ({
  hasRole: (roles: string[], required: string) => roles.includes(required),
  Role: { Member: 'member' },
}))
vi.mock('$lib/modules/registry', () => ({ composeCapabilities: mockComposeCapabilities }))
vi.mock('$lib/server/content/content-db', () => ({
  deleteMailingList: mockDeleteList,
  addListMember: mockAddMember,
  removeListMember: mockRemoveMember,
}))

import { DELETE as deleteList } from './[id]/+server'
import { POST as addMember } from './[id]/members/+server'
import { DELETE as removeMember } from './[id]/members/[memberId]/+server'

const LIST = '6f2d1c3b-8a4e-4f0a-9b7c-1d2e3f4a5b6c'
const MEMBER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const author = { roles: ['member'], groups: ['authors'], id: 'u1' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ev(params: Record<string, string>, body?: unknown): any {
  return {
    request: new Request('http://stura.test/api/content/lists/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),
    locals: { user: author },
    params,
  }
}

describe('/api/content/lists/[id]/** id validation (H08)', () => {
  beforeEach(() => {
    mockComposeCapabilities.mockReset().mockReturnValue({ 'content.author': ['authors'] })
    mockDeleteList.mockReset().mockResolvedValue(undefined)
    mockAddMember.mockReset().mockResolvedValue(undefined)
    mockRemoveMember.mockReset().mockResolvedValue(undefined)
  })

  it.each(['../x', '..', 'l1'])('DELETE list 404s %j without a backend call', async (id) => {
    await expect(deleteList(ev({ id }))).rejects.toMatchObject({ status: 404 })
    expect(mockDeleteList).not.toHaveBeenCalled()
  })

  it('POST member 404s a traversal list id without a backend call', async () => {
    await expect(addMember(ev({ id: 'x/../../posts' }, { email: 'a@x.de' }))).rejects.toMatchObject({
      status: 404,
    })
    expect(mockAddMember).not.toHaveBeenCalled()
  })

  it('DELETE member 404s a traversal member id without a backend call', async () => {
    await expect(removeMember(ev({ id: LIST, memberId: '../../lists' }))).rejects.toMatchObject({
      status: 404,
    })
    expect(mockRemoveMember).not.toHaveBeenCalled()
  })

  it('UUID ids reach the backend unchanged', async () => {
    await deleteList(ev({ id: LIST }))
    await addMember(ev({ id: LIST }, { email: 'A@X.de' }))
    await removeMember(ev({ id: LIST, memberId: MEMBER }))
    expect(mockDeleteList).toHaveBeenCalledWith(LIST)
    expect(mockAddMember).toHaveBeenCalledWith(LIST, { email: 'a@x.de', name: null, source: 'manual' })
    expect(mockRemoveMember).toHaveBeenCalledWith(LIST, MEMBER)
  })
})
