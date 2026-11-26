// @vitest-environment node
//
// MATRIX_IDENTITY=namespaced: the app mints the Matrix token itself (Synapse admin login-as-user)
// after it has checked, locally, whose token it is. The request shapes are pinned here against a
// scripted homeserver; cross-customer behaviour on ONE shared homeserver is in tenant-isolation.test.ts.
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
// The tokens below are unsigned stand-ins (`h.<claims>.s`): the verifier accepts exactly that shape and
// hands back its claims. That the real verifier is asked, and refuses, is pinned in matrix-identity.verify.test.ts.
vi.mock('$lib/server/jwt-verify', () => {
  const claimsOf = (token: string): Record<string, unknown> | null => {
    const [, body, sig] = token.split('.')
    return sig === 's' && body ? (JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as Record<string, unknown>) : null
  }
  return {
    verifyBearerJwt: async (token: string) => claimsOf(token),
    verifyBearerJwtResult: async (token: string) => {
      const payload = claimsOf(token)
      return payload ? { ok: true, payload } : { ok: false, reason: 'rejected' }
    },
  }
})

import { __resetMatrixCachesForTests, getMatrixClient } from './matrix-client'
import { __resetSynapseAdminForTests } from './synapse-admin'
import { getMessagesBackend } from './backend'

const ACME = { id: 'tid-acme', slug: 'acme', issuer: 'https://id.example.org/realms/acme' } as unknown as TenantContext
const BETA = { id: 'tid-beta', slug: 'beta', issuer: 'https://id.example.org/realms/beta' } as unknown as TenantContext
const as = <T>(t: TenantContext, fn: () => T): T => runWithTenant(t, fn)

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
function token(claims: Record<string, unknown>): string {
  const body = { sub: 'sub-1', preferred_username: 'alice', iss: ACME.issuer, exp: Math.floor(NOW / 1000) + 3600, ...claims }
  return `h.${Buffer.from(JSON.stringify(body)).toString('base64url')}.s`
}

interface Call {
  method: string
  path: string
  auth: string | null
  body: string | undefined
}
let calls: Call[]
/** What the scripted homeserver answers. */
let flows: Array<{ type: string }>
let loginProbeStatus: number
let existingUser: { deactivated: boolean } | null
let mintCount: number

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  __resetMatrixCachesForTests()
  __resetSynapseAdminForTests()
  process.env.MATRIX_IDENTITY = 'namespaced'
  delete process.env.MESSAGES_BACKEND
  calls = []
  flows = [{ type: 'm.login.password' }]
  loginProbeStatus = 200
  existingUser = null
  mintCount = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const u = new URL(String(input))
      const method = String(init?.method ?? 'GET')
      const path = decodeURIComponent(u.pathname)
      calls.push({ method, path, auth: new Headers(init?.headers as HeadersInit).get('Authorization'), body: typeof init?.body === 'string' ? init.body : undefined })
      if (method === 'GET' && path === '/_matrix/client/v3/login') {
        return loginProbeStatus === 200 ? Response.json({ flows }) : Response.json({ errcode: 'M_UNKNOWN' }, { status: loginProbeStatus })
      }
      if (path.startsWith('/_synapse/admin/v2/users/')) {
        if (method === 'GET') return existingUser ? Response.json(existingUser) : Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 })
        return Response.json({})
      }
      if (method === 'POST' && /^\/_synapse\/admin\/v1\/users\/.+\/login$/.test(path)) return Response.json({ access_token: `mx-${++mintCount}` })
      return Response.json({ errcode: 'M_UNRECOGNIZED' }, { status: 404 })
    }),
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete process.env.MATRIX_IDENTITY
  delete process.env.MESSAGES_BACKEND
})

const mint = (t: TenantContext, jwt: string, deviceId?: string) => as(t, () => getMatrixClient().getMatrixToken(jwt, deviceId))
const adminCalls = () => calls.filter((c) => c.path.startsWith('/_synapse/'))

describe('the admin login request', () => {
  test('is a POST to the namespaced user with the admin token and a body that holds only valid_until_ms', async () => {
    const t = await mint(ACME, token({}))
    expect(t).toBe('mx-1')
    const login = calls.find((c) => c.method === 'POST')!
    expect(login.path).toBe('/_synapse/admin/v1/users/@acme.alice:synapse.test/login')
    expect(login.auth).toBe('Bearer admin-shared')
    expect(login.body).toBe(JSON.stringify({ valid_until_ms: NOW + 3_600_000 }))
  })

  test('carries no device_id, and a device id handed in by the caller is not forwarded', async () => {
    await mint(ACME, token({}), 'DEVICE1')
    for (const c of calls) expect(c.body ?? '').not.toContain('device')
  })

  test('never uses the JWT login type', async () => {
    await mint(ACME, token({}))
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/_matrix/client/v3/login')).toEqual([])
  })

  test('encodes an address-shaped username into the user id', async () => {
    await mint(ACME, token({ preferred_username: 'max@example.org' }))
    expect(calls.find((c) => c.method === 'POST')!.path).toBe('/_synapse/admin/v1/users/@acme.max_40example.org:synapse.test/login')
  })
})

describe('the account', () => {
  test('is created when the homeserver does not know it, with the name claim as display name', async () => {
    await mint(ACME, token({ name: 'Alice Example' }))
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.path).toBe('/_synapse/admin/v2/users/@acme.alice:synapse.test')
    expect(put.body).toBe(JSON.stringify({ displayname: 'Alice Example', deactivated: false }))
    expect(calls.findIndex((c) => c.method === 'PUT')).toBeLessThan(calls.findIndex((c) => c.method === 'POST'))
  })

  test('is not given an address as display name', async () => {
    await mint(ACME, token({ name: 'alice@example.org' }))
    expect(calls.find((c) => c.method === 'PUT')!.body).toBe(JSON.stringify({ deactivated: false }))
  })

  test('is left as it is when it exists: no write, no overwritten display name', async () => {
    existingUser = { deactivated: false }
    await mint(ACME, token({ name: 'Alice Example' }))
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([])
    expect(calls.some((c) => c.method === 'POST')).toBe(true)
  })

  test('is never reactivated by a login: a deactivated (erased) account gets no token', async () => {
    existingUser = { deactivated: true }
    await expect(mint(ACME, token({}))).rejects.toMatchObject({ status: 403 })
    expect(calls.filter((c) => c.method === 'PUT' || c.method === 'POST')).toEqual([])
  })
})

describe('whose token it is', () => {
  test('a token of another customer\'s issuer is refused before any request leaves', async () => {
    await expect(mint(ACME, token({ iss: BETA.issuer }))).rejects.toMatchObject({ status: 403 })
    expect(calls).toEqual([])
  })

  test('a token without an issuer is refused', async () => {
    await expect(mint(ACME, token({ iss: undefined }))).rejects.toMatchObject({ status: 403 })
    expect(calls).toEqual([])
  })

  test('a trailing slash of the issuer does not matter', async () => {
    expect(await mint(ACME, token({ iss: `${ACME.issuer}/` }))).toBe('mx-1')
  })

  test('a cached token is not served to a token of another issuer carrying the same subject', async () => {
    await mint(ACME, token({}))
    await expect(mint(ACME, token({ iss: BETA.issuer }))).rejects.toMatchObject({ status: 403 })
  })

  test('a token without a username cannot be mapped and is refused', async () => {
    await expect(mint(ACME, token({ preferred_username: undefined }))).rejects.toMatchObject({ status: 403 })
    expect(calls).toEqual([])
  })

  test('the same username in two customers is two accounts and two tokens', async () => {
    const a = await mint(ACME, token({}))
    const b = await mint(BETA, token({ iss: BETA.issuer }))
    expect(a).not.toBe(b)
    const logins = calls.filter((c) => c.method === 'POST').map((c) => c.path)
    expect(logins).toEqual(['/_synapse/admin/v1/users/@acme.alice:synapse.test/login', '/_synapse/admin/v1/users/@beta.alice:synapse.test/login'])
  })
})

describe('caching', () => {
  test('a second call inside the token lifetime makes no request', async () => {
    const first = await mint(ACME, token({}))
    const n = calls.length
    expect(await mint(ACME, token({}))).toBe(first)
    expect(calls.length).toBe(n)
  })

  test('the cached token is replaced a little before the homeserver would reject it', async () => {
    const first = await mint(ACME, token({}))
    vi.setSystemTime(NOW + 3_600_000 - 30_000)
    expect(await mint(ACME, token({ exp: Math.floor(NOW / 1000) + 7200 }))).not.toBe(first)
  })

  test('two calls started together share one login', async () => {
    const [a, b] = await Promise.all([mint(ACME, token({})), mint(ACME, token({}))])
    expect(a).toBe(b)
    expect(mintCount).toBe(1)
  })
})

describe('chat is refused while the homeserver offers another way to log in', () => {
  const refusal = { status: 503, body: { message: expect.stringMatching(/Chat/) } }

  test('a JWT login flow: 503 in German, no account touched, no token minted', async () => {
    flows = [{ type: 'm.login.password' }, { type: 'org.matrix.login.jwt' }]
    await expect(mint(ACME, token({}))).rejects.toMatchObject(refusal)
    expect(adminCalls()).toEqual([])
  })

  test('a single sign-on flow: 503', async () => {
    flows = [{ type: 'm.login.sso' }]
    await expect(mint(ACME, token({}))).rejects.toMatchObject(refusal)
    expect(adminCalls()).toEqual([])
  })

  test('a probe that fails: 503 (fail closed), not a token', async () => {
    loginProbeStatus = 500
    await expect(mint(ACME, token({}))).rejects.toMatchObject(refusal)
    expect(adminCalls()).toEqual([])
  })

  test('a probe that cannot connect: 503', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(mint(ACME, token({}))).rejects.toMatchObject(refusal)
  })

  test('the probe asks without any credential', async () => {
    await mint(ACME, token({}))
    const probe = calls.find((c) => c.path === '/_matrix/client/v3/login')!
    expect(probe).toMatchObject({ method: 'GET', auth: null })
  })

  test('a clean answer is remembered for a minute: the next user does not probe again, an hour later it does', async () => {
    await mint(ACME, token({}))
    await mint(ACME, token({ preferred_username: 'bob', sub: 'sub-2' }))
    expect(calls.filter((c) => c.path === '/_matrix/client/v3/login')).toHaveLength(1)
    vi.setSystemTime(NOW + 61_000)
    await mint(ACME, token({ preferred_username: 'carol', sub: 'sub-3', exp: Math.floor(NOW / 1000) + 7200 }))
    expect(calls.filter((c) => c.path === '/_matrix/client/v3/login')).toHaveLength(2)
  })

  test('a refusal is not remembered: once the flow is gone the next call gets its token', async () => {
    flows = [{ type: 'org.matrix.login.jwt' }]
    await expect(mint(ACME, token({}))).rejects.toMatchObject({ status: 503 })
    flows = [{ type: 'm.login.password' }]
    expect(await mint(ACME, token({}))).toBe('mx-1')
  })

  test('MESSAGES_BACKEND=service is refused without any request', async () => {
    process.env.MESSAGES_BACKEND = 'service'
    await expect(mint(ACME, token({}))).rejects.toMatchObject(refusal)
    expect(calls).toEqual([])
  })

  test('the service client refuses to exchange a token in namespaced mode, before any request', async () => {
    process.env.MESSAGES_BACKEND = 'service'
    process.env.MESSAGES_SERVICE_URL = 'http://messages-service:8080'
    try {
      await expect(as(ACME, () => getMessagesBackend().matrix().getMatrixToken(token({})))).rejects.toMatchObject(refusal)
      expect(calls).toEqual([])
    } finally {
      delete process.env.MESSAGES_SERVICE_URL
    }
  })

  test('every operation of the service client is refused, and the soft credential lookup degrades to nothing, before any request', async () => {
    process.env.MESSAGES_BACKEND = 'service'
    process.env.MESSAGES_SERVICE_URL = 'http://messages-service:8080'
    try {
      await expect(as(ACME, () => getMessagesBackend().synapse().forceJoinRoom('!r:synapse.test', '@acme.alice:synapse.test'))).rejects.toMatchObject(refusal)
      const event = { request: new Request('http://localhost/api/video/token', { headers: { Authorization: `Bearer ${token({})}` } }), locals: {} } as never
      expect(await as(ACME, () => getMessagesBackend().resolveMatrixCreds(event))).toEqual({ userId: '', accessToken: '' })
      expect(calls).toEqual([])
    } finally {
      delete process.env.MESSAGES_SERVICE_URL
    }
  })

  test('an unknown MATRIX_IDENTITY value refuses chat instead of falling back to the legacy identity', async () => {
    process.env.MATRIX_IDENTITY = 'namespace'
    await expect(mint(ACME, token({}))).rejects.toMatchObject({ status: 503 })
    expect(calls).toEqual([])
  })
})
