// @vitest-environment node
//
// Golden pins of the LEGACY chat identity: with MATRIX_IDENTITY unset or `legacy` every request, id,
// alias and room body the app produces is what it was before the namespaced mode existed. These
// tests were written and run green on the commit before the switch was added; they are the proof
// that the switch is off by default. The namespaced mode has its own tests (matrix-identity.*.test.ts,
// tenant-isolation.test.ts).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'

const ENV = vi.hoisted(
  () =>
    ({
      MATRIX_URL: 'http://synapse.test:8008',
      SYNAPSE_ADMIN_TOKEN: 'admin-shared',
      SYNAPSE_ADMIN_BOT_USER_ID: '@bot:synapse.test',
      SYNAPSE_SERVER_NAME: 'synapse.test',
    }) as Record<string, string | undefined>,
)
vi.mock('$env/dynamic/private', () => ({ env: ENV }))
vi.mock('$lib/server/env/service-env', () => ({ serviceEnv: (name: string) => ENV[name] }))
const KC = vi.hoisted(() => ({ username: 'max.mustermann' }))
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClientForCurrentTenant: () => ({ getUser: async () => ({ username: KC.username }) }),
}))

import { __resetMatrixCachesForTests, getMatrixClient } from './matrix-client'
import { __resetSynapseAdminForTests, getSynapseAdmin } from './synapse-admin'
import { messagingErasureHook } from './erasure'

const TENANT = { id: 'tid-x', slug: 'x', issuer: 'https://id.example.org/realms/x' } as unknown as TenantContext
const as = <T>(fn: () => T): T => runWithTenant(TENANT, fn)
const jwt = `h.${Buffer.from(JSON.stringify({ sub: 'u1', preferred_username: 'alice', iss: TENANT.issuer, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.s`

interface Call {
  method: string
  url: string
  body: string | undefined
}
let calls: Call[]

beforeEach(() => {
  __resetMatrixCachesForTests()
  __resetSynapseAdminForTests()
  delete process.env.MATRIX_IDENTITY
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ method: String(init?.method ?? 'GET'), url: String(input), body: typeof init?.body === 'string' ? init.body : undefined })
      return Response.json({ access_token: 'mx-1', room_id: '!r:synapse.test' }, { status: 200 })
    }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.MATRIX_IDENTITY
})

describe('legacy identity, MATRIX_IDENTITY unset', () => {
  test('the Matrix token is one JWT login with the Keycloak token and nothing else', async () => {
    await as(() => getMatrixClient().getMatrixToken(jwt))
    expect(calls).toEqual([{ method: 'POST', url: 'http://synapse.test:8008/_matrix/client/v3/login', body: JSON.stringify({ type: 'org.matrix.login.jwt', token: jwt }) }])
  })

  test('a device id travels as device_id of the same login', async () => {
    await as(() => getMatrixClient().getMatrixToken(jwt, 'dev-1'))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toBe(JSON.stringify({ type: 'org.matrix.login.jwt', token: jwt, device_id: 'dev-1' }))
  })

  test('a Keycloak token of a foreign issuer is still exchanged (the issuer check belongs to the namespaced mode)', async () => {
    const foreign = `h.${Buffer.from(JSON.stringify({ sub: 'u2', iss: 'https://other.example.org/realms/y', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.s`
    await as(() => getMatrixClient().getMatrixToken(foreign))
    expect(calls).toHaveLength(1)
  })

  test('createRoom sends this exact body, without any initial state', async () => {
    await as(() => getMatrixClient().createRoom('Vorstand', 'Gruppenraum fuer Vorstand', 'stura-vorstand'))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://synapse.test:8008/_matrix/client/v3/createRoom')
    expect(calls[0]!.body).toBe(
      '{"name":"Vorstand","topic":"Gruppenraum fuer Vorstand","preset":"private_chat","power_level_content_override":{"events":{"org.matrix.msc4143.rtc.member":0,"org.matrix.msc3401.call.member":0,"m.call.member":0,"io.element.call.encryption_keys":0}},"room_alias_name":"stura-vorstand"}',
    )
  })

  test('createUser is one admin PUT of the bare localpart', async () => {
    await as(() => getSynapseAdmin().createUser('alice', 'Alice Example'))
    expect(calls).toEqual([{ method: 'PUT', url: 'http://synapse.test:8008/_synapse/admin/v2/users/%40alice%3Asynapse.test', body: '{"displayname":"Alice Example","deactivated":false}' }])
  })

  test('getUserLoginToken without an expiry keeps its empty body', async () => {
    await as(() => getSynapseAdmin().getUserLoginToken('alice'))
    expect(calls).toEqual([{ method: 'POST', url: 'http://synapse.test:8008/_synapse/admin/v1/users/%40alice%3Asynapse.test/login', body: '{}' }])
  })

  test('erasure addresses the account named by the Keycloak username, unprefixed', async () => {
    const res = await as(() => messagingErasureHook.erase({ tenantId: 'tid-x', subjectId: 'kc-1', db: null } as never))
    expect(res).toEqual({ status: 'erased', counts: { matrix_accounts: 1 } })
    expect(calls).toEqual([{ method: 'POST', url: 'http://synapse.test:8008/_synapse/admin/v1/deactivate/%40max.mustermann%3Asynapse.test', body: '{"erase":true}' }])
  })
})

describe('legacy identity, MATRIX_IDENTITY=legacy written out', () => {
  test('the same login, the same createRoom body, the same erasure path', async () => {
    process.env.MATRIX_IDENTITY = 'legacy'
    await as(() => getMatrixClient().getMatrixToken(jwt))
    await as(() => getMatrixClient().createRoom('Vorstand', 'T', 'stura-vorstand'))
    await as(() => messagingErasureHook.erase({ tenantId: 'tid-x', subjectId: 'kc-1', db: null } as never))
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://synapse.test:8008/_matrix/client/v3/login',
      'POST http://synapse.test:8008/_matrix/client/v3/createRoom',
      'POST http://synapse.test:8008/_synapse/admin/v1/deactivate/%40max.mustermann%3Asynapse.test',
    ])
    expect(calls[0]!.body).toBe(JSON.stringify({ type: 'org.matrix.login.jwt', token: jwt }))
    expect(calls[1]!.body).not.toContain('initial_state')
  })
})
