import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PATCH, DELETE } from './+server'

// Closing and deleting a poll: only the people who create polls (council admins and above) may do it,
// the check is on the server, and the write runs as the module's own Nextcloud account (the owner of every
// poll), never as the acting member.
const h = vi.hoisted(() => ({
  closePoll: vi.fn(),
  deletePoll: vi.fn(),
  getPoll: vi.fn(),
  perUser: vi.fn(),
  referenced: vi.fn(),
}))

vi.mock('$lib/server/polls/polls-client', () => ({
  createPollsClient: h.perUser,
  NextcloudPollsClient: { closePoll: h.closePoll, deletePoll: h.deletePoll, getPoll: h.getPoll },
}))
vi.mock('$lib/server/protocols/protocol-db', () => ({ protocolReferencesPoll: h.referenced }))
vi.mock('$lib/auth', () => {
  const ladder: Record<string, string[]> = {
    'it-admin': ['it-admin', 'council-admin', 'member'],
    'council-admin': ['council-admin', 'member'],
    member: ['member'],
  }
  return {
    Role: { Member: 'member', CouncilAdmin: 'council-admin', ITAdmin: 'it-admin' },
    hasRole: (roles: string[], required: string) => roles.some((r) => ladder[r]?.includes(required)),
  }
})

const locals = (roles: string[]) => ({ accessToken: 'kc-token', auth: async () => ({ user: { id: 'u1', roles } }) })
const patch = (id: string, body: unknown, roles: string[]) =>
  PATCH({ params: { id }, request: new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }), locals: locals(roles) } as never)
const del = (id: string, roles: string[]) => DELETE({ params: { id }, locals: locals(roles) } as never)

beforeEach(() => {
  vi.clearAllMocks()
  h.closePoll.mockResolvedValue({ id: 7, status: { expired: true } })
  h.deletePoll.mockResolvedValue(undefined)
  h.referenced.mockResolvedValue(false)
})

describe('PATCH /api/polls/[id] (close)', () => {
  it.each([['council-admin'], ['it-admin']])('%s closes the poll, through the module account', async (role) => {
    const res = await patch('7', { closed: true }, [role])
    expect(res.status).toBe(200)
    expect(h.closePoll).toHaveBeenCalledWith(7)
    expect(h.perUser).not.toHaveBeenCalled()
    expect((await res.json()).data).toEqual({ id: 7, closed: true })
  })

  it('a plain member is refused (403) and nothing is written', async () => {
    const res = await patch('7', { closed: true }, ['member'])
    expect(res.status).toBe(403)
    expect(h.closePoll).not.toHaveBeenCalled()
  })

  it('someone who is not signed in is refused', async () => {
    const res = await PATCH({ params: { id: '7' }, request: new Request('http://x', { method: 'PATCH', body: '{"closed":true}' }), locals: { auth: async () => null } } as never)
    expect(res.status).toBe(403)
    expect(h.closePoll).not.toHaveBeenCalled()
  })

  it('only closing is offered: a body that asks for anything else is a 400', async () => {
    for (const body of [{}, { closed: false }, { title: 'x' }, null]) {
      expect((await patch('7', body, ['council-admin'])).status).toBe(400)
    }
    expect(h.closePoll).not.toHaveBeenCalled()
  })

  it('a malformed poll id is a 400', async () => {
    expect((await patch('abc', { closed: true }, ['council-admin'])).status).toBe(400)
    expect(h.closePoll).not.toHaveBeenCalled()
  })

  it('a poll of another tenant or one that does not exist answers 404', async () => {
    h.closePoll.mockRejectedValue(Object.assign(new Error('poll not found'), { pollsStatus: 404 }))
    expect((await patch('7', { closed: true }, ['council-admin'])).status).toBe(404)
  })
})

describe('DELETE /api/polls/[id]', () => {
  it.each([['council-admin'], ['it-admin']])('%s deletes the poll, through the module account', async (role) => {
    const res = await del('7', [role])
    expect(res.status).toBe(200)
    expect(h.deletePoll).toHaveBeenCalledWith(7)
    expect(h.perUser).not.toHaveBeenCalled()
  })

  it('a plain member is refused (403) and nothing is deleted', async () => {
    const res = await del('7', ['member'])
    expect(res.status).toBe(403)
    expect(h.deletePoll).not.toHaveBeenCalled()
  })

  it('a poll a protocol points at is kept (409)', async () => {
    h.referenced.mockResolvedValue(true)
    const res = await del('7', ['council-admin'])
    expect(res.status).toBe(409)
    expect(h.referenced).toHaveBeenCalledWith('7')
    expect(h.deletePoll).not.toHaveBeenCalled()
  })

  it('the protocol check runs only after the tenant check: another tenant\'s poll is a plain 404', async () => {
    h.getPoll.mockRejectedValue(Object.assign(new Error('poll not found'), { pollsStatus: 404 }))
    const res = await del('7', ['council-admin'])
    expect(res.status).toBe(404)
    expect(h.deletePoll).not.toHaveBeenCalled()
  })

  it('a malformed poll id is a 400', async () => {
    expect((await del('0', ['council-admin'])).status).toBe(400)
    expect(h.deletePoll).not.toHaveBeenCalled()
  })
})
