// @vitest-environment node
// F1-FIX-01-K (H03, K1#8/#38, K1#6): the Keycloak admin client must (a) never
// splice an unencoded id into a realm-admin REST path, (b) put an AbortSignal
// on every outbound fetch, (c) share one in-flight token request.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { KeycloakAdminClient } from '$lib/server/keycloak-admin'

const BASE = 'http://kc-test:8080'
const REALM = 'r1'
const PREFIX = `${BASE}/admin/realms/${REALM}`
const EVIL = '../clients/x/client-secret'
const ENC = encodeURIComponent(EVIL) // ..%2Fclients%2Fx%2Fclient-secret
/** AbortSignal.timeout() rejects with "The operation was aborted due to timeout". */
const TIMED_OUT = /timeout|aborted/i

interface Call {
  url: string
  method: string
  signal: AbortSignal | null | undefined
}

/** Fetch stub: records every call, answers the token endpoint, and answers
 *  everything else with an empty 200 JSON list (or 201 + Location for POST). */
function stubFetch(): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method, signal: init?.signal })
      if (url.includes('/protocol/openid-connect/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 300 }), { status: 200 })
      }
      if (method === 'POST' && (url.endsWith('/children') || url.endsWith('/groups') || url.endsWith('/users'))) {
        return new Response(null, { status: 201, headers: { Location: `${url}/new-id` } })
      }
      if (method === 'PUT' || method === 'DELETE') return new Response(null, { status: 204 })
      return new Response(JSON.stringify([]), { status: 200 })
    }),
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function client(opts?: { timeoutMs?: number }) {
  return new KeycloakAdminClient(BASE, REALM, 'cid', 'secret', opts)
}

/** Every admin (non-token) request URL, so a test can assert on the path only. */
const adminCalls = (calls: Call[]) => calls.filter((c) => !c.url.includes('/protocol/openid-connect/token'))

describe('H03: path segments are encoded (getGroup / getUser and every other id-bearing call)', () => {
  it('getGroup: the id is one encoded path segment', async () => {
    const calls = stubFetch()
    await client().getGroup(EVIL).catch(() => undefined)
    expect(adminCalls(calls).map((c) => c.url)).toEqual([`${PREFIX}/groups/${ENC}`])
  })

  it('getUser: an encoded-slash id is not decoded into a path traversal', async () => {
    const calls = stubFetch()
    await client().getUser('..%2Fclients').catch(() => undefined)
    expect(adminCalls(calls).map((c) => c.url)).toEqual([`${PREFIX}/users/${encodeURIComponent('..%2Fclients')}`])
  })

  it.each([
    ['getUser', (c: KeycloakAdminClient) => c.getUser(EVIL), `/users/${ENC}`],
    ['updateUser', (c: KeycloakAdminClient) => c.updateUser(EVIL, { enabled: false }), `/users/${ENC}`],
    ['deleteUser', (c: KeycloakAdminClient) => c.deleteUser(EVIL), `/users/${ENC}`],
    ['listUserGroups', (c: KeycloakAdminClient) => c.listUserGroups(EVIL), `/users/${ENC}/groups`],
    ['addUserToGroup (userId)', (c: KeycloakAdminClient) => c.addUserToGroup(EVIL, 'g1'), `/users/${ENC}/groups/g1`],
    ['addUserToGroup (groupId)', (c: KeycloakAdminClient) => c.addUserToGroup('u1', EVIL), `/users/u1/groups/${ENC}`],
    ['removeUserFromGroup (userId)', (c: KeycloakAdminClient) => c.removeUserFromGroup(EVIL, 'g1'), `/users/${ENC}/groups/g1`],
    ['removeUserFromGroup (groupId)', (c: KeycloakAdminClient) => c.removeUserFromGroup('u1', EVIL), `/users/u1/groups/${ENC}`],
    ['listUserRoles', (c: KeycloakAdminClient) => c.listUserRoles(EVIL), `/users/${ENC}/role-mappings/realm`],
    ['assignRoles', (c: KeycloakAdminClient) => c.assignRoles(EVIL, []), `/users/${ENC}/role-mappings/realm`],
    ['executeActionsEmail', (c: KeycloakAdminClient) => c.executeActionsEmail(EVIL, ['VERIFY_EMAIL']), `/users/${ENC}/execute-actions-email`],
    ['listSubGroups', (c: KeycloakAdminClient) => c.listSubGroups(EVIL), `/groups/${ENC}/children`],
    ['createSubgroup (raw fetch)', (c: KeycloakAdminClient) => c.createSubgroup(EVIL, 'kid'), `/groups/${ENC}/children`],
    ['updateGroup', (c: KeycloakAdminClient) => c.updateGroup(EVIL, { name: 'n' }), `/groups/${ENC}`],
    ['deleteGroup', (c: KeycloakAdminClient) => c.deleteGroup(EVIL), `/groups/${ENC}`],
    ['listGroupMembers', (c: KeycloakAdminClient) => c.listGroupMembers(EVIL), `/groups/${ENC}/members`],
    ['getGroupMembers', (c: KeycloakAdminClient) => c.getGroupMembers(EVIL), `/groups/${ENC}/members?first=0&max=1000`],
    ['hasOtpCredential', (c: KeycloakAdminClient) => c.hasOtpCredential(EVIL), `/users/${ENC}/credentials`],
  ])('%s encodes the id (encoded slash + dot segments cannot escape the segment)', async (_name, call, expectedPath) => {
    const calls = stubFetch()
    await call(client()).catch(() => undefined)
    expect(adminCalls(calls).map((c) => c.url)).toEqual([`${PREFIX}${expectedPath}`])
  })

  it.each(['.', '..', ''])('rejects the dot-segment / empty id %j without any admin fetch', async (bad) => {
    const calls = stubFetch()
    const c = client()
    await expect(c.getGroup(bad)).rejects.toThrow('Invalid Keycloak id')
    await expect(c.getUser(bad)).rejects.toThrow('Invalid Keycloak id')
    await expect(c.deleteGroup(bad)).rejects.toThrow('Invalid Keycloak id')
    await expect(c.createSubgroup(bad, 'kid')).rejects.toThrow('Invalid Keycloak id')
    await expect(c.addUserToGroup('u1', bad)).rejects.toThrow('Invalid Keycloak id')
    expect(adminCalls(calls)).toEqual([])
  })

  it('a normal uuid id is left readable (encoding is the identity on unreserved characters)', async () => {
    const calls = stubFetch()
    const id = '3f2c1d0e-1a2b-4c3d-8e9f-0a1b2c3d4e5f'
    await client().getGroup(id).catch(() => undefined)
    expect(adminCalls(calls).map((c) => c.url)).toEqual([`${PREFIX}/groups/${id}`])
  })
})

describe('K1#8/#38: every Keycloak fetch carries an AbortSignal', () => {
  it('token, request, createUser, createGroup and createSubgroup all pass a signal', async () => {
    const calls = stubFetch()
    const c = client()
    await c.listUsers()
    await c.createUser({ username: 'u', email: 'u@x.test', enabled: true, emailVerified: false })
    await c.createGroup('g')
    await c.createSubgroup('p1', 'kid')
    expect(calls.length).toBeGreaterThanOrEqual(5) // 1 token + 4 admin calls
    for (const call of calls) {
      expect(call.signal, `${call.method} ${call.url}`).toBeInstanceOf(AbortSignal)
    }
  })

  /** A fetch that only ever settles by rejecting when its signal aborts. */
  function hangingFetch(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: string | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const sig = init?.signal
            if (!sig) return // no signal: hangs forever (the pre-fix behaviour)
            sig.addEventListener('abort', () => reject(sig.reason as Error))
          }),
      ),
    )
  }

  it('a hung token endpoint rejects within the budget', async () => {
    hangingFetch()
    const started = Date.now()
    await expect(client({ timeoutMs: 40 }).listUsers()).rejects.toThrow(TIMED_OUT)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('a hung admin endpoint rejects within the budget (token succeeds, admin call hangs)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL, init?: RequestInit) => {
        if (String(input).includes('/protocol/openid-connect/token')) {
          return Promise.resolve(new Response(JSON.stringify({ access_token: 't', expires_in: 300 }), { status: 200 }))
        }
        return new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal
          if (!sig) return
          sig.addEventListener('abort', () => reject(sig.reason as Error))
        })
      }),
    )
    const started = Date.now()
    await expect(client({ timeoutMs: 40 }).getGroup('g1')).rejects.toThrow(TIMED_OUT)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('a hung raw-fetch call (createSubgroup) rejects within the budget', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL, init?: RequestInit) => {
        if (String(input).includes('/protocol/openid-connect/token')) {
          return Promise.resolve(new Response(JSON.stringify({ access_token: 't', expires_in: 300 }), { status: 200 }))
        }
        return new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal
          if (!sig) return
          sig.addEventListener('abort', () => reject(sig.reason as Error))
        })
      }),
    )
    const started = Date.now()
    await expect(client({ timeoutMs: 40 }).createSubgroup('p1', 'kid')).rejects.toThrow(TIMED_OUT)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('K1#8: the token request is single-flight', () => {
  it('two concurrent calls on a cold client share one token fetch', async () => {
    const calls = stubFetch()
    const c = client()
    await Promise.all([c.listUsers(), c.listGroups()])
    expect(calls.filter((x) => x.url.includes('/protocol/openid-connect/token'))).toHaveLength(1)
  })

  it('a failed token fetch does not poison the next attempt', async () => {
    let n = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        if (String(input).includes('/protocol/openid-connect/token')) {
          n += 1
          if (n === 1) return new Response('nope', { status: 500 })
          return new Response(JSON.stringify({ access_token: 't', expires_in: 300 }), { status: 200 })
        }
        return new Response(JSON.stringify([]), { status: 200 })
      }),
    )
    const c = client()
    await expect(c.listUsers()).rejects.toThrow('Keycloak token fetch failed')
    await expect(c.listUsers()).resolves.toEqual([])
  })
})

describe('K1#6: exact username lookup', () => {
  it('listUsers({ username, exact }) queries username=..&exact=true and not search', async () => {
    const calls = stubFetch()
    await client().listUsers({ username: 'anna.berger', exact: true, max: 2 })
    const u = new URL(adminCalls(calls)[0]!.url)
    expect(u.searchParams.get('username')).toBe('anna.berger')
    expect(u.searchParams.get('exact')).toBe('true')
    expect(u.searchParams.has('search')).toBe(false)
  })
})
