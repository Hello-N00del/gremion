import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Nextcloud Polls answers a poll id it does not know with 400 (not 404). The by-id
// routes must turn that into the same 404 a foreign or missing poll gets; before,
// the plain Error from the client reached SvelteKit and the caller saw a 500.
// These cases run the REAL client against a stubbed fetch (the sibling route suite
// mocks the client and so cannot see the mapping).
vi.mock('$lib/server/env/service-env', () => ({
  serviceEnv: (n: string) => ({ NEXTCLOUD_URL: 'http://nc', NEXTCLOUD_ADMIN_USER: 'admin', NEXTCLOUD_ADMIN_PASSWORD: 'pw' } as Record<string, string>)[n],
}))
vi.mock('$env/dynamic/private', () => ({ env: {} }))
vi.mock('$lib/server/tenant/context', () => ({ getTenant: () => ({ id: 'A', slug: 'a' }) }))
vi.mock('$lib/auth', () => ({
  hasRole: () => true,
  Role: { Member: 'member', CouncilAdmin: 'council-admin' },
}))

const answer = (status: number) =>
  vi.fn(async () => new Response(JSON.stringify({ ocs: { meta: {}, data: {} } }), { status }))

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

const locals = { accessToken: 'tok', auth: async () => ({ user: { id: 'u', roles: ['member'] } }) }

describe.each([400, 404])('Nextcloud answers %i for an unknown poll id', (ncStatus) => {
  it('GET /api/polls/[id] answers 404', async () => {
    vi.stubGlobal('fetch', answer(ncStatus))
    const { GET } = await import('./+server')
    // @ts-expect-error partial event
    const res = await GET({ params: { id: '99999' }, locals })
    expect(res.status).toBe(404)
  })

  it('GET /api/polls/[id]/options answers 404', async () => {
    vi.stubGlobal('fetch', answer(ncStatus))
    const { GET } = await import('./options/+server')
    // @ts-expect-error partial event
    await expect(GET({ params: { id: '99999' }, locals })).rejects.toMatchObject({ status: 404 })
  })
})

describe('Nextcloud failing for another reason stays a server error', () => {
  it('a 500 from Nextcloud is not turned into 404', async () => {
    vi.stubGlobal('fetch', answer(500))
    const { GET } = await import('./+server')
    // @ts-expect-error partial event
    await expect(GET({ params: { id: '99999' }, locals })).rejects.toThrow(/Nextcloud Polls/)
  })
})
