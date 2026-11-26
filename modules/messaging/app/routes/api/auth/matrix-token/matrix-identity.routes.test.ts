// @vitest-environment node
//
// The two auth routes that name a Matrix account by hand: the id guessed when the homeserver's
// whoami does not answer (matrix-token) and the account whose device is deleted (matrix-device).
// With MATRIX_IDENTITY=namespaced both go through the customer namespace; legacy keeps the bare
// username. A refusal of the token exchange (503) reaches the client as it is.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { error } from '@sveltejs/kit'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'

const h = vi.hoisted(() => ({
  getMatrixToken: vi.fn(),
  getJoinedRooms: vi.fn(),
  deleteDevice: vi.fn(),
}))

vi.mock('$lib/server/messages/backend', () => ({
  getMessagesBackend: () => ({
    matrix: () => ({ getMatrixToken: h.getMatrixToken, getJoinedRooms: h.getJoinedRooms }),
    synapse: () => ({ deleteDevice: h.deleteDevice, forceJoinRoom: vi.fn() }),
  }),
}))
vi.mock('$lib/server/env/service-env', () => ({ serviceEnv: (name: string) => ({ MATRIX_URL: 'http://synapse.test:8008', SYNAPSE_SERVER_NAME: 'synapse.test' })[name] }))
vi.mock('$lib/server/messages/auto-join', () => ({ autoJoinOwnUnitRooms: vi.fn() }))

import { GET as tokenGet } from './+server'
import { DELETE as deviceDelete } from '../matrix-device/+server'

const ACME = { id: 'tid-acme', slug: 'acme', issuer: 'https://id.example.org/realms/acme' } as unknown as TenantContext
const USER = { id: 'sub-1', preferredUsername: 'alice', roles: [] }

function tokenEvent() {
  return {
    locals: { user: USER },
    request: new Request('http://localhost/api/auth/matrix-token', { headers: { Authorization: 'Bearer kc-jwt' } }),
    url: new URL('http://localhost/api/auth/matrix-token'),
  } as never
}
function deviceEvent() {
  return {
    locals: { user: USER },
    request: new Request('http://localhost/api/auth/matrix-device', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'DEV1' }) }),
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.MATRIX_IDENTITY
  h.getMatrixToken.mockResolvedValue('matrix-token')
  h.getJoinedRooms.mockResolvedValue(['!r:synapse.test'])
  h.deleteDevice.mockResolvedValue(undefined)
  // the homeserver's whoami does not answer: the route falls back to a derived id
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.MATRIX_IDENTITY
})

const idOf = async (res: Response) => ((await res.json()) as { data: { matrixUserId: string } }).data.matrixUserId

describe('GET /api/auth/matrix-token: the id used when whoami does not answer', () => {
  test('legacy: the bare username', async () => {
    expect(await idOf((await runWithTenant(ACME, () => tokenGet(tokenEvent()))) as Response)).toBe('@alice:synapse.test')
  })

  test('namespaced: the customer slug and the escaped username', async () => {
    process.env.MATRIX_IDENTITY = 'namespaced'
    expect(await idOf((await runWithTenant(ACME, () => tokenGet(tokenEvent()))) as Response)).toBe('@acme.alice:synapse.test')
  })

  test('a refusal of the exchange (503) is not turned into a 502', async () => {
    process.env.MATRIX_IDENTITY = 'namespaced'
    let refusal: unknown
    try {
      error(503, 'Der Chat ist derzeit nicht verfügbar. Bitte die Administration informieren.')
    } catch (e) {
      refusal = e
    }
    h.getMatrixToken.mockRejectedValue(refusal)
    await expect(runWithTenant(ACME, () => tokenGet(tokenEvent()))).rejects.toMatchObject({ status: 503 })
  })

  test('a token that is not this customer\'s (403) reaches the client as it is', async () => {
    process.env.MATRIX_IDENTITY = 'namespaced'
    let refusal: unknown
    try {
      error(403, 'Die Anmeldung gehört nicht zu diesem Mandanten.')
    } catch (e) {
      refusal = e
    }
    h.getMatrixToken.mockRejectedValue(refusal)
    await expect(runWithTenant(ACME, () => tokenGet(tokenEvent()))).rejects.toMatchObject({ status: 403 })
  })

  test('any other HTTP error of the exchange (a 401, say) is still a 502 as before', async () => {
    let missing: unknown
    try {
      error(401, 'No Keycloak access token in session')
    } catch (e) {
      missing = e
    }
    h.getMatrixToken.mockRejectedValue(missing)
    const res = (await runWithTenant(ACME, () => tokenGet(tokenEvent()))) as Response
    expect(res.status).toBe(502)
  })

  test('any other failure is still a 502 with the same message as before', async () => {
    h.getMatrixToken.mockRejectedValue(new Error('boom'))
    const res = (await runWithTenant(ACME, () => tokenGet(tokenEvent()))) as Response
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ success: false, error: 'Matrix token exchange failed: boom' })
  })
})

describe('DELETE /api/auth/matrix-device: whose device is deleted', () => {
  test('legacy: the bare username', async () => {
    await runWithTenant(ACME, () => deviceDelete(deviceEvent()))
    expect(h.deleteDevice).toHaveBeenCalledWith('alice', 'DEV1')
  })

  test('namespaced: the account of this customer, never the bare username', async () => {
    process.env.MATRIX_IDENTITY = 'namespaced'
    await runWithTenant(ACME, () => deviceDelete(deviceEvent()))
    expect(h.deleteDevice).toHaveBeenCalledWith('acme.alice', 'DEV1')
  })
})
