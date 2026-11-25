// @vitest-environment node
//
// resolveMatrixCreds is soft: a failed exchange gives empty credentials and the caller degrades. The one
// exception is a refusal made on purpose (MATRIX_IDENTITY=namespaced: 503 chat not available, 403 token
// not this customer's): it is rethrown, so the caller answers it (German 503/403) instead of treating it
// as a missing Matrix identity (English 403 or a silently degraded call token).
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { error } from '@sveltejs/kit'

const h = vi.hoisted(() => ({ getMatrixToken: vi.fn() }))
vi.mock('$lib/server/messages/matrix-client', () => ({ getMatrixClient: () => ({ getMatrixToken: h.getMatrixToken }) }))
vi.mock('$lib/server/env/service-env', () => ({ serviceEnv: () => 'http://synapse.test:8008' }))

import { resolveMatrixCreds } from './matrix-creds'

function refusal(status: number, message: string): unknown {
  try {
    error(status, message)
  } catch (e) {
    return e
  }
  return undefined
}
function event(): never {
  return { request: new Request('http://localhost/x', { headers: { Authorization: 'Bearer kc-jwt' } }), locals: {} } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user_id: '@alice:synapse.test' }), { status: 200 })))
})

describe('resolveMatrixCreds', () => {
  test('a working exchange gives the id and the token', async () => {
    h.getMatrixToken.mockResolvedValue('mx-token')
    expect(await resolveMatrixCreds(event())).toEqual({ userId: '@alice:synapse.test', accessToken: 'mx-token' })
  })

  test('a refused exchange (503) is rethrown', async () => {
    h.getMatrixToken.mockRejectedValue(refusal(503, 'Der Chat ist derzeit nicht verfügbar. Bitte die Administration informieren.'))
    await expect(resolveMatrixCreds(event())).rejects.toMatchObject({ status: 503 })
  })

  test('a token that is not this customer\'s (403) is rethrown', async () => {
    h.getMatrixToken.mockRejectedValue(refusal(403, 'Die Anmeldung gehört nicht zu diesem Mandanten.'))
    await expect(resolveMatrixCreds(event())).rejects.toMatchObject({ status: 403 })
  })

  test('any other failure stays soft: empty credentials', async () => {
    h.getMatrixToken.mockRejectedValue(new Error('boom'))
    expect(await resolveMatrixCreds(event())).toEqual({ userId: '', accessToken: '' })
  })

  test('a missing session token (401) stays soft as before', async () => {
    const noAuth = { request: new Request('http://localhost/x'), locals: { auth: async () => ({}) } } as never
    expect(await resolveMatrixCreds(noAuth)).toEqual({ userId: '', accessToken: '' })
    expect(h.getMatrixToken).not.toHaveBeenCalled()
  })
})
