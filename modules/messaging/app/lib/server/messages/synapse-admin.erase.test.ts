import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'

// TRD-196: SynapseAdminClient.eraseUser — GDPR deactivation through the Synapse
// admin API (POST /_synapse/admin/v1/deactivate/<user_id> {erase:true}).
vi.mock('$lib/server/env/service-env', async () => {
  const { env } = await import('$env/dynamic/private')
  return { serviceEnv: (name: string) => (env as Record<string, string | undefined>)[name] }
})
vi.mock('$env/dynamic/private', () => ({
  env: { MATRIX_URL: 'http://matrix.test:8008', SYNAPSE_ADMIN_TOKEN: 'admin-token', SYNAPSE_SERVER_NAME: 'matrix.test' },
}))

import { getSynapseAdmin, __resetSynapseAdminForTests } from './synapse-admin'

const CTX = { id: 'tid-erase', slug: 'erase' } as unknown as TenantContext

describe('SynapseAdminClient.eraseUser', () => {
  let calls: { url: string; method: string; body: unknown; auth: string }[]

  function stub(status: number, body: unknown = {}) {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        method: String(init.method),
        body: init.body ? JSON.parse(init.body as string) : undefined,
        auth: (init.headers as Record<string, string>).Authorization,
      })
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    })
  }

  beforeEach(() => {
    calls = []
    __resetSynapseAdminForTests()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs deactivate with erase:true for @localpart:server and reports true', async () => {
    stub(200, { id_server_unbind_result: 'success' })
    const ok = await runWithTenant(CTX, () => getSynapseAdmin().eraseUser('jdoe'))
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('http://matrix.test:8008/_synapse/admin/v1/deactivate/' + encodeURIComponent('@jdoe:matrix.test'))
    expect(calls[0].body).toEqual({ erase: true })
    expect(calls[0].auth).toBe('Bearer admin-token')
  })

  it('an unknown user (404) is false, not an error', async () => {
    stub(404, { errcode: 'M_NOT_FOUND', error: 'User not found' })
    expect(await runWithTenant(CTX, () => getSynapseAdmin().eraseUser('nobody'))).toBe(false)
  })

  it('any other failure throws', async () => {
    stub(403, { errcode: 'M_FORBIDDEN', error: 'You are not a server admin' })
    await expect(runWithTenant(CTX, () => getSynapseAdmin().eraseUser('jdoe'))).rejects.toThrow(/not a server admin/)
  })

  it('refuses an empty localpart and a localpart that already carries a server part', async () => {
    stub(200)
    await expect(runWithTenant(CTX, () => getSynapseAdmin().eraseUser(' '))).rejects.toThrow(/localpart/)
    await expect(runWithTenant(CTX, () => getSynapseAdmin().eraseUser('@a:b'))).rejects.toThrow(/localpart/)
    expect(calls).toHaveLength(0)
  })
})
