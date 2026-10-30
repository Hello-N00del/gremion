// @vitest-environment node
// Typed Keycloak admin errors. A failed admin call is a KcAdminError carrying the
// HTTP status; "not found" is decided on that status, never on a substring of the
// message (a 500 whose body happens to mention "404" is not a missing user/group).
// Timeouts name the method and path so a hung call is attributable in the logs.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { KeycloakAdminClient, KcAdminError, KcInvalidIdError } from '$lib/server/keycloak-admin'

const BASE = 'http://kc-test:8080'
const REALM = 'r1'
const UUID = '3f2c1d0e-1a2b-4c3d-8e9f-0a1b2c3d4e5f'
const TOKEN_OK = () => new Response(JSON.stringify({ access_token: 't', expires_in: 300 }), { status: 200 })
const isToken = (input: string | URL) => String(input).includes('/protocol/openid-connect/token')

/** Token endpoint answers; every admin call answers with the given status + body. */
function stubAdminAnswer(status: number, body: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => (isToken(input) ? TOKEN_OK() : new Response(body, { status }))),
  )
}

function client(opts?: { timeoutMs?: number }) {
  return new KeycloakAdminClient(BASE, REALM, 'cid', 'secret', opts)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('KcAdminError', () => {
  it('carries the status and keeps the historic message text', async () => {
    stubAdminAnswer(500, 'boom')
    const err = await client().listUsers().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KcAdminError)
    expect((err as KcAdminError).status).toBe(500)
    expect((err as KcAdminError).message).toBe('Keycloak Admin API error: 500 boom')
  })

  it('postCreate failures are typed too (createGroup answering 409)', async () => {
    stubAdminAnswer(409, 'exists')
    const err = await client().createGroup('g').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KcAdminError)
    expect((err as KcAdminError).status).toBe(409)
    expect((err as KcAdminError).message).toBe('Keycloak Admin API error: 409 exists')
  })
})

describe('getUser / getGroup decide "not found" on the status, not on the body text', () => {
  const upstream = JSON.stringify({ error: 'upstream /users/404 failed' })

  it('getUser: a 500 whose body mentions 404 is a KcAdminError(500), not "User not found"', async () => {
    stubAdminAnswer(500, upstream)
    const err = await client().getUser(UUID).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KcAdminError)
    expect((err as KcAdminError).status).toBe(500)
    expect((err as KcAdminError).message).toMatch(/^Keycloak Admin API error: 500/)
  })

  it('getGroup: a 500 whose body mentions 404 is a KcAdminError(500), not "Group not found"', async () => {
    stubAdminAnswer(500, upstream)
    const err = await client().getGroup(UUID).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KcAdminError)
    expect((err as KcAdminError).status).toBe(500)
    expect((err as KcAdminError).message).toMatch(/^Keycloak Admin API error: 500/)
  })

  it('getUser: a real 404 still maps to the Error("User not found") sentinel the erasure paths match', async () => {
    stubAdminAnswer(404, '{"error":"User not found"}')
    const err = await client().getUser(UUID).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(KcAdminError)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('User not found')
  })

  it('getGroup: a real 404 propagates as KcAdminError(404) for the caller to branch on', async () => {
    stubAdminAnswer(404, '{"error":"Could not find group"}')
    const err = await client().getGroup(UUID).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KcAdminError)
    expect((err as KcAdminError).status).toBe(404)
  })
})

describe('KcInvalidIdError', () => {
  it.each(['.', '..', ''])('seg() rejects %j with a typed error whose message stays "Invalid Keycloak id"', async (bad) => {
    stubAdminAnswer(200, '[]')
    const err = await client().getGroup(bad).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KcInvalidIdError)
    expect((err as Error).message).toBe('Invalid Keycloak id')
  })
})

describe('timeouts name the method and path', () => {
  /** Token succeeds immediately; every other call only settles when its signal aborts. */
  function hangAdmin(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL, init?: RequestInit) => {
        if (isToken(input)) return Promise.resolve(TOKEN_OK())
        return new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal
          if (!sig) return
          sig.addEventListener('abort', () => reject(sig.reason as Error))
        })
      }),
    )
  }

  it('an admin GET: "Keycloak GET /groups/<id> timed out after 40ms" with the original cause', async () => {
    hangAdmin()
    const err = await client({ timeoutMs: 40 }).getGroup(UUID).catch((e: unknown) => e)
    expect((err as Error).message).toBe(`Keycloak GET /groups/${UUID} timed out after 40ms`)
    expect(((err as Error).cause as Error).name).toMatch(/TimeoutError|AbortError/)
  })

  it('the path in the message drops the query string', async () => {
    hangAdmin()
    const err = await client({ timeoutMs: 40 }).getGroupMembers(UUID).catch((e: unknown) => e)
    expect((err as Error).message).toBe(`Keycloak GET /groups/${UUID}/members timed out after 40ms`)
  })

  it('a raw-fetch POST (createSubgroup) is named too', async () => {
    hangAdmin()
    const err = await client({ timeoutMs: 40 }).createSubgroup(UUID, 'kid').catch((e: unknown) => e)
    expect((err as Error).message).toBe(`Keycloak POST /groups/${UUID}/children timed out after 40ms`)
  })

  it('the token request is named', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: string | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error))
          }),
      ),
    )
    const err = await client({ timeoutMs: 40 }).listUsers().catch((e: unknown) => e)
    expect((err as Error).message).toBe(
      `Keycloak POST /realms/${REALM}/protocol/openid-connect/token timed out after 40ms`,
    )
  })

  it('a non-timeout transport failure is rethrown unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        if (isToken(input)) return TOKEN_OK()
        throw new TypeError('fetch failed')
      }),
    )
    const err = await client().listUsers().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TypeError)
    expect((err as Error).message).toBe('fetch failed')
  })
})
