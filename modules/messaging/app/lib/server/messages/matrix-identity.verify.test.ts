// @vitest-environment node
//
// MATRIX_IDENTITY=namespaced: the app names the Matrix account itself, from the claims of the token it
// is handed. The claims are only believed after the token was verified against THIS customer's key set,
// issuer and audience; the check is made here, not left to whoever calls the exchange. These tests use
// real RS256 tokens (the other namespaced tests use unsigned stand-ins with a stubbed verifier) against
// a scripted homeserver and a scripted key endpoint.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
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

import { __resetMatrixCachesForTests, getMatrixClient } from './matrix-client'
import { __resetSynapseAdminForTests } from './synapse-admin'
import { __resetJwksCache } from '$lib/server/jwt-verify'

const ACME = { id: 'tid-acme', slug: 'acme', issuer: 'https://id.example.org/realms/acme' } as unknown as TenantContext
const as = <T>(t: TenantContext, fn: () => T): T => runWithTenant(t, fn)
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const KEY_URL = `${ACME.issuer}/protocol/openid-connect/certs`

type Keys = Awaited<ReturnType<typeof generateKeyPair>>
let own: Keys
let foreign: Keys
let ownJwk: Record<string, unknown>
let calls: string[]
let keyRequests: number

async function sign(
  keys: Keys,
  claims: Record<string, unknown> = {},
  opts: { aud?: string; exp?: number; iss?: string } = {},
): Promise<string> {
  const jwt = new SignJWT({ sub: 'sub-1', preferred_username: 'alice', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? ACME.issuer)
    .setAudience(opts.aud ?? 'gremion-ui')
    .setIssuedAt(Math.floor(NOW / 1000))
    .setExpirationTime(opts.exp ?? Math.floor(NOW / 1000) + 3600)
  return jwt.sign(keys.privateKey)
}

beforeEach(async () => {
  own = await generateKeyPair('RS256')
  foreign = await generateKeyPair('RS256')
  ownJwk = { ...(await exportJWK(own.publicKey)), kid: 'k1', use: 'sig', alg: 'RS256' }
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  __resetMatrixCachesForTests()
  __resetSynapseAdminForTests()
  __resetJwksCache()
  process.env.MATRIX_IDENTITY = 'namespaced'
  delete process.env.MESSAGES_BACKEND
  calls = []
  keyRequests = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const raw = input instanceof Request ? input.url : String(input)
      if (raw === KEY_URL) {
        keyRequests++
        return Response.json({ keys: [ownJwk] })
      }
      const u = new URL(raw)
      const method = String(init?.method ?? 'GET')
      const path = decodeURIComponent(u.pathname)
      calls.push(`${method} ${path}`)
      if (method === 'GET' && path === '/_matrix/client/v3/login') return Response.json({ flows: [{ type: 'm.login.password' }] })
      if (path.startsWith('/_synapse/admin/v2/users/')) {
        return method === 'GET' ? Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 }) : Response.json({})
      }
      if (method === 'POST' && /^\/_synapse\/admin\/v1\/users\/.+\/login$/.test(path)) return Response.json({ access_token: 'mx-1' })
      return Response.json({ errcode: 'M_UNRECOGNIZED' }, { status: 404 })
    }),
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete process.env.MATRIX_IDENTITY
})

const mint = (jwt: string) => as(ACME, () => getMatrixClient().getMatrixToken(jwt))
const adminCalls = () => calls.filter((c) => c.includes('/_synapse/'))

describe('the token is verified before its claims name an account', () => {
  test('a token signed by the customer\'s key is exchanged, and the key set of that customer was asked', async () => {
    expect(await mint(await sign(own))).toBe('mx-1')
    expect(keyRequests).toBe(1)
    expect(adminCalls()).toContain('POST /_synapse/admin/v1/users/@acme.alice:synapse.test/login')
  })

  test('a token with the right claims but another key\'s signature is refused: 403, no account touched', async () => {
    await expect(mint(await sign(foreign, { preferred_username: 'admin' }))).rejects.toMatchObject({ status: 403 })
    expect(adminCalls()).toEqual([])
  })

  test('a token that carries no signature at all is refused the same way', async () => {
    const forged = `h.${Buffer.from(JSON.stringify({ sub: 's', preferred_username: 'alice', iss: ACME.issuer, exp: Math.floor(NOW / 1000) + 3600 })).toString('base64url')}.s`
    await expect(mint(forged)).rejects.toMatchObject({ status: 403 })
    expect(adminCalls()).toEqual([])
  })

  test('a validly signed token for another audience is refused', async () => {
    await expect(mint(await sign(own, {}, { aud: 'some-other-client' }))).rejects.toMatchObject({ status: 403 })
    expect(adminCalls()).toEqual([])
  })

  test('the audience of the mobile client is accepted like it is on the API', async () => {
    expect(await mint(await sign(own, {}, { aud: 'gremion-mobile' }))).toBe('mx-1')
  })

  test('an expired token is refused with the refresh error, also while a token for that user sits in the cache', async () => {
    await mint(await sign(own))
    const expired = await sign(own, {}, { exp: Math.floor(NOW / 1000) - 10 })
    const n = calls.length
    await expect(mint(expired)).rejects.toThrow(/expired/)
    expect(calls.length).toBe(n)
  })

  test('a verified token is not verified against the key set again for every call', async () => {
    await mint(await sign(own))
    await mint(await sign(own))
    expect(keyRequests).toBe(1)
  })
})
