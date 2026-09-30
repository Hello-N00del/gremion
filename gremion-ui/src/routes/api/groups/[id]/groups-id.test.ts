// @vitest-environment node
// F1-FIX-01-K (H03): /api/groups/[id] must never forward a non-uuid id to the
// Keycloak realm-admin API. SvelteKit hands the handler the DECODED param, so
// `..%2Fclients` arrives as `../clients`.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const kc = {
  getGroup: vi.fn(),
  updateGroup: vi.fn(),
  deleteGroup: vi.fn(),
}
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClient: () => kc,
}))
vi.mock('$lib/auth', () => ({
  hasRole: vi.fn(() => true),
  Role: { Guest: 'guest', Member: 'member', CouncilAdmin: 'council-admin', ITAdmin: 'it-admin' },
}))

import { GET, PATCH, DELETE } from './+server'

const UUID = '3f2c1d0e-1a2b-4c3d-8e9f-0a1b2c3d4e5f'
const locals = {
  tenant: { id: 'default' },
  auth: async () => ({ user: { id: 'u-admin', roles: ['council-admin', 'it-admin'], groups: [] } }),
}
const patchReq = () =>
  new Request('http://localhost/api/groups/x', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'renamed' }),
  })

const BAD_IDS = ['../clients/x/client-secret', '..', '.', '..%2Fclients', 'a/b', '', '3f2c1d0e-1a2b-4c3d-8e9f-0a1b2c3d4e5f/../x']

beforeEach(() => {
  kc.getGroup.mockReset().mockResolvedValue({ id: UUID, name: 'g', path: '/g' })
  kc.updateGroup.mockReset().mockResolvedValue(undefined)
  kc.deleteGroup.mockReset().mockResolvedValue(undefined)
})

describe('api/groups/[id] id validation', () => {
  it.each(BAD_IDS)('GET %j answers 404 and makes no Keycloak admin call', async (id) => {
    // @ts-expect-error partial event
    const res = await GET({ params: { id }, locals })
    expect(res.status).toBe(404)
    expect(kc.getGroup).not.toHaveBeenCalled()
  })

  it.each(BAD_IDS)('PATCH %j answers 404 and makes no Keycloak admin call', async (id) => {
    // @ts-expect-error partial event
    const res = await PATCH({ params: { id }, locals, request: patchReq() })
    expect(res.status).toBe(404)
    expect(kc.updateGroup).not.toHaveBeenCalled()
  })

  it.each(BAD_IDS)('DELETE %j answers 404 and makes no Keycloak admin call', async (id) => {
    // @ts-expect-error partial event
    const res = await DELETE({ params: { id }, locals })
    expect(res.status).toBe(404)
    expect(kc.deleteGroup).not.toHaveBeenCalled()
  })

  it('a valid uuid still reaches Keycloak', async () => {
    // @ts-expect-error partial event
    const get = await GET({ params: { id: UUID }, locals })
    expect(get.status).toBe(200)
    expect(kc.getGroup).toHaveBeenCalledWith(UUID)
    // @ts-expect-error partial event
    const patch = await PATCH({ params: { id: UUID }, locals, request: patchReq() })
    expect(patch.status).toBe(200)
    expect(kc.updateGroup).toHaveBeenCalledWith(UUID, { name: 'renamed' })
    // @ts-expect-error partial event
    const del = await DELETE({ params: { id: UUID }, locals })
    expect(del.status).toBe(200)
    expect(kc.deleteGroup).toHaveBeenCalledWith(UUID)
  })

  it('the role check still runs first: a non-admin gets 403, not a 404 oracle', async () => {
    const guest = { ...locals, auth: async () => ({ user: { id: 'u', roles: [], groups: [] } }) }
    const { hasRole } = await import('$lib/auth')
    vi.mocked(hasRole).mockReturnValueOnce(false)
    // @ts-expect-error partial event
    const res = await GET({ params: { id: '..' }, locals: guest })
    expect(res.status).toBe(403)
  })
})
