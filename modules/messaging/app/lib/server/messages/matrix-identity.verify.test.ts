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
import { REFRESH_GRACE_MS } from '$lib/auth/refresh-grace'
import { isChatRefusal } from './chat-identity-guard'
import { error as kitError } from '@sveltejs/kit'

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
/** How the scripted key endpoint behaves: `up`, `down` (answers 500) or `unreachable` (the request fails). */
let keyEndpoint: 'up' | 'down' | 'unreachable'

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
  keyEndpoint = 'up'
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const raw = input instanceof Request ? input.url : String(input)
      if (raw === KEY_URL) {
        keyRequests++
        if (keyEndpoint === 'unreachable') throw new TypeError('fetch failed')
        if (keyEndpoint === 'down') return new Response('unavailable', { status: 500 })
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

  test('a token that expired within the refresh grace is served like the session layer serves it, also from the cache', async () => {
    await mint(await sign(own))
    const inGrace = await sign(own, {}, { exp: Math.floor(NOW / 1000) - 10 })
    const n = calls.length
    expect(await mint(inGrace)).toBe('mx-1')
    expect(calls.length).toBe(n)
  })

  test('a token that expired within the refresh grace is exchanged when nothing is cached yet', async () => {
    const edge = await sign(own, {}, { exp: Math.floor(NOW / 1000) - (REFRESH_GRACE_MS / 1000 - 1) })
    expect(await mint(edge)).toBe('mx-1')
  })

  test('a token that expired before the grace is refused with a 401 the client answers by refreshing, never a 500', async () => {
    await mint(await sign(own))
    const expired = await sign(own, {}, { exp: Math.floor(NOW / 1000) - REFRESH_GRACE_MS / 1000 - 1 })
    const n = calls.length
    const refusal = await mint(expired).then(
      () => null,
      (e: unknown) => e,
    )
    expect(refusal).toMatchObject({ status: 401, body: { message: 'Die Anmeldung ist abgelaufen. Bitte erneut anmelden.' } })
    expect(isChatRefusal(refusal)).toBe(true)
    expect(calls.length).toBe(n)
  })

  test('only that expiry is passed on as a 401: an ordinary 401 of a route is still wrapped by it', () => {
    let ordinary: unknown
    try {
      kitError(401, 'No Keycloak access token in session')
    } catch (e) {
      ordinary = e
    }
    expect(ordinary).toMatchObject({ status: 401 })
    expect(isChatRefusal(ordinary)).toBe(false)
  })
})

describe('an unreachable key set is told apart from a forged token', () => {
  let logged: string[]
  beforeEach(() => {
    logged = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('a key endpoint that answers 500 gives 503 (chat not available), no account is touched, the cause is logged without the token', async () => {
    keyEndpoint = 'down'
    const jwt = await sign(own)
    const refusal = await mint(jwt).then(
      () => null,
      (e: unknown) => e,
    )
    expect(refusal).toMatchObject({ status: 503 })
    expect(isChatRefusal(refusal)).toBe(true)
    expect(adminCalls()).toEqual([])
    const line = logged.find((l) => l.includes('tid-acme'))
    expect(line).toBeDefined()
    expect(line).toContain('ERR_JOSE_GENERIC')
    expect(logged.join(' ')).not.toContain(jwt)
    expect(logged.join(' ')).not.toContain(jwt.split('.')[1] ?? 'x')
  })

  test('a key endpoint that cannot be reached gives 503 as well', async () => {
    keyEndpoint = 'unreachable'
    await expect(mint(await sign(own))).rejects.toMatchObject({ status: 503 })
    expect(adminCalls()).toEqual([])
    expect(logged.some((l) => l.includes('tid-acme') && l.includes('TypeError'))).toBe(true)
  })

  test('with the key endpoint up again the same token is exchanged: an outage is not remembered', async () => {
    keyEndpoint = 'down'
    const jwt = await sign(own)
    await expect(mint(jwt)).rejects.toMatchObject({ status: 503 })
    keyEndpoint = 'up'
    __resetJwksCache()
    expect(await mint(jwt)).toBe('mx-1')
  })

  test('a forged token while the key endpoint is up is still 403 and logs no outage', async () => {
    await expect(mint(await sign(foreign))).rejects.toMatchObject({ status: 403 })
    expect(logged).toEqual([])
  })
})

describe('the verified token still counts once per call', () => {
  test('a verified token is not verified against the key set again for every call', async () => {
    await mint(await sign(own))
    await mint(await sign(own))
    expect(keyRequests).toBe(1)
  })
})
