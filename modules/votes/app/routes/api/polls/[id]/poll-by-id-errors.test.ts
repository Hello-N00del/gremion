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

// Nextcloud answers 400 for an id it does not know, but also for a poll a per-user bearer cannot
// read (a misconfiguration). Both are a 404 for the caller; the upstream status stays visible in
// the server log so the misconfiguration is not hidden.
describe('the upstream status stays visible in the server log', () => {
  it.each([400, 403, 404])('a %i from Nextcloud is logged with its status when mapped to 404', async (ncStatus) => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', answer(ncStatus))
    const { GET } = await import('./+server')
    // @ts-expect-error partial event
    const res = await GET({ params: { id: '99999' }, locals })
    expect(res.status).toBe(404)
    const logged = JSON.stringify(log.mock.calls)
    expect(logged).toContain('polls')
    expect(logged).toContain(String(ncStatus))
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
