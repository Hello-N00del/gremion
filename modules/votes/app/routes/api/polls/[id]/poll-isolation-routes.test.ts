import { describe, expect, it, vi } from 'vitest'
import { GET, POST } from './+server'
import { GET as OPTIONS_GET } from './options/+server'

// Route-level mapping of the client's tenant/integrity refusals: another tenant's
// poll is a plain 404 on every by-id route, a closed / already-voted poll is 409.
const refuse = (pollsStatus: number) => Object.assign(new Error('refused'), { pollsStatus })
const { getPollWithOptions, vote } = vi.hoisted(() => ({ getPollWithOptions: vi.fn(), vote: vi.fn() }))

vi.mock('$lib/server/polls/polls-client', () => ({
  createPollsClient: () => ({ getPollWithOptions, vote }),
}))
vi.mock('$lib/auth', () => ({ hasRole: () => true, Role: { Member: 'member' } }))

const locals = { accessToken: 'tok', auth: async () => ({ user: { roles: ['member'] } }) }
const req = (body: unknown) => ({ json: async () => body }) as Request

describe('by-id poll routes', () => {
  it('GET /api/polls/[id]: foreign poll -> 404', async () => {
    getPollWithOptions.mockRejectedValue(refuse(404))
    // @ts-expect-error partial event
    expect((await GET({ params: { id: '5' }, locals })).status).toBe(404)
  })

  it('GET /api/polls/[id]/options: foreign poll -> 404', async () => {
    getPollWithOptions.mockRejectedValue(refuse(404))
    // @ts-expect-error partial event
    await expect(OPTIONS_GET({ params: { id: '5' }, locals })).rejects.toMatchObject({ status: 404 })
  })

  it('POST vote: foreign poll -> 404, closed/already voted -> 409', async () => {
    vote.mockRejectedValueOnce(refuse(404))
    // @ts-expect-error partial event
    expect((await POST({ params: { id: '5' }, request: req({ optionId: 9 }), locals })).status).toBe(404)
    vote.mockRejectedValueOnce(refuse(409))
    // @ts-expect-error partial event
    expect((await POST({ params: { id: '5' }, request: req({ optionId: 9 }), locals })).status).toBe(409)
  })
})
