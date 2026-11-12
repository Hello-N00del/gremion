// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

// One fake Keycloak admin client per tenant, resolved the way the real registry does it: by the tenant the
// caller's request carries. A route that built its client from anything but locals.tenant would reach the
// wrong realm here and the cross-tenant case below would fail.
type KcUser = { id: string; username: string; email: string; firstName: string; lastName: string; enabled: boolean; attributes?: unknown }
const realms: Record<string, { listUsers: ReturnType<typeof vi.fn> }> = {
  'tenant-a': { listUsers: vi.fn() },
  'tenant-b': { listUsers: vi.fn() },
}
const clientFor = vi.fn((tenant: { id: string }) => {
  const kc = realms[tenant.id]
  if (!kc) throw new Error(`no realm for ${tenant.id}`)
  return kc
})
vi.mock('$lib/server/keycloak-admin', () => ({ getKeycloakAdminClient: (t: { id: string }) => clientFor(t) }))

import { GET } from './+server'

const user = (id: string, username: string, extra: Partial<KcUser> = {}): KcUser => ({
  id,
  username,
  email: `${username}@example.test`,
  firstName: 'Vorname',
  lastName: username.toUpperCase(),
  enabled: true,
  ...extra,
})

const A_USERS = [user('a-1', 'anna'), user('a-2', 'berta'), user('a-sa', 'service-account-gremion-admin')]
const B_USERS = [user('b-1', 'canary-from-b')]

function event(opts: { roles?: string[] | null; tenant?: string | null; query?: string } = {}) {
  const { roles = ['council-admin'], tenant = 'tenant-a', query = '' } = opts
  return {
    url: new URL(`http://x/api/users${query}`),
    locals: {
      auth: async () => (roles === null ? null : { user: { id: 'caller', roles } }),
      tenant: tenant === null ? undefined : { id: tenant, realmName: `realm-${tenant}` },
    },
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  realms['tenant-a'].listUsers.mockResolvedValue(A_USERS)
  realms['tenant-b'].listUsers.mockResolvedValue(B_USERS)
})

describe('GET /api/users: who may call it', () => {
  it('401 when nobody is signed in, and Keycloak is not asked', async () => {
    const res = await GET(event({ roles: null, query: '?search=an' }))
    expect(res.status).toBe(401)
    expect(clientFor).not.toHaveBeenCalled()
  })

  it('403 for a plain member and for a finance role, Keycloak is not asked', async () => {
    for (const roles of [['member'], ['finance'], ['guest']]) {
      const res = await GET(event({ roles, query: '?search=an' }))
      expect(res.status).toBe(403)
    }
    expect(clientFor).not.toHaveBeenCalled()
  })

  it('a council-admin and an it-admin (by the role hierarchy) are served', async () => {
    for (const roles of [['council-admin'], ['it-admin']]) {
      const res = await GET(event({ roles, query: '?search=an' }))
      expect(res.status).toBe(200)
    }
  })

  it('403 when the request carries no tenant: it never falls back to a default realm', async () => {
    const res = await GET(event({ tenant: null, query: '?search=an' }))
    expect(res.status).toBe(403)
    expect(clientFor).not.toHaveBeenCalled()
  })
})

describe('GET /api/users: tenant scope', () => {
  it('a council-admin of tenant A gets the users of A and only A, through A\'s client alone', async () => {
    const res = await GET(event({ tenant: 'tenant-a', query: '?search=an&slim=true&max=10' }))
    const body = (await res.json()) as { data: { id: string }[] }
    expect(res.status).toBe(200)
    expect(body.data.map((u) => u.id)).toEqual(['a-1', 'a-2'])
    expect(clientFor).toHaveBeenCalledTimes(1)
    expect(clientFor.mock.calls[0][0]).toMatchObject({ id: 'tenant-a' })
    expect(realms['tenant-a'].listUsers).toHaveBeenCalledTimes(1)
    expect(realms['tenant-b'].listUsers).not.toHaveBeenCalled()
    expect(JSON.stringify(body)).not.toContain('canary-from-b')
  })

  it('the same request from tenant B reaches B\'s realm and none of A\'s users', async () => {
    const res = await GET(event({ tenant: 'tenant-b', query: '?search=an' }))
    const body = (await res.json()) as { data: { id: string }[] }
    expect(body.data.map((u) => u.id)).toEqual(['b-1'])
    expect(realms['tenant-a'].listUsers).not.toHaveBeenCalled()
  })

  it('a tenant query parameter or header cannot redirect the search to another tenant', async () => {
    const res = await GET(event({ tenant: 'tenant-a', query: '?search=an&tenant=tenant-b&realm=realm-tenant-b' }))
    const body = (await res.json()) as { data: { id: string }[] }
    expect(body.data.map((u) => u.id)).toEqual(['a-1', 'a-2'])
    expect(realms['tenant-b'].listUsers).not.toHaveBeenCalled()
  })
})

describe('GET /api/users: what is returned', () => {
  it('returns exactly id, email, firstName, lastName, username: no attributes, no flags', async () => {
    realms['tenant-a'].listUsers.mockResolvedValue([user('a-1', 'anna', { attributes: { phone: ['0'] } })])
    const res = await GET(event({ query: '?search=an' }))
    const body = (await res.json()) as { data: Record<string, unknown>[] }
    expect(Object.keys(body.data[0]).sort()).toEqual(['email', 'firstName', 'id', 'lastName', 'username'])
  })

  it('a user whose profile has no e-mail or name still carries all five fields (Keycloak omits unset attributes; the contract requires them)', async () => {
    realms['tenant-a'].listUsers.mockResolvedValue([{ id: 'a-9', username: 'bare', enabled: true } as KcUser])
    const res = await GET(event({ query: '?search=bare' }))
    const body = (await res.json()) as { data: Record<string, unknown>[] }
    expect(body.data[0]).toEqual({ id: 'a-9', username: 'bare', email: '', firstName: '', lastName: '' })
  })

  it('leaves out service accounts (the kernel\'s own admin client is a Keycloak user)', async () => {
    const res = await GET(event({ query: '?search=service' }))
    const body = (await res.json()) as { data: { username: string }[] }
    expect(body.data.some((u) => u.username.startsWith('service-account-'))).toBe(false)
  })

  it('asks Keycloak for enabled users only, with the trimmed term as an infix search (users.search.test.ts has the matching)', async () => {
    await GET(event({ query: '?search=%20anna%20' }))
    expect(realms['tenant-a'].listUsers).toHaveBeenCalledWith({ search: '*anna*', max: 10, first: 0, enabled: true })
  })
})

describe('GET /api/users: bounds', () => {
  it('max defaults to 10 and is clamped to 1..25', async () => {
    const maxOf = async (query: string) => {
      realms['tenant-a'].listUsers.mockClear()
      await GET(event({ query }))
      return (realms['tenant-a'].listUsers.mock.calls[0][0] as { max: number }).max
    }
    expect(await maxOf('?search=an')).toBe(10)
    expect(await maxOf('?search=an&max=5')).toBe(5)
    expect(await maxOf('?search=an&max=100000')).toBe(25)
    expect(await maxOf('?search=an&max=0')).toBe(1)
    expect(await maxOf('?search=an&max=-3')).toBe(1)
    expect(await maxOf('?search=an&max=abc')).toBe(10)
  })

  it('first is a non-negative integer, bounded', async () => {
    await GET(event({ query: '?search=an&first=-5' }))
    expect((realms['tenant-a'].listUsers.mock.calls[0][0] as { first: number }).first).toBe(0)
    realms['tenant-a'].listUsers.mockClear()
    await GET(event({ query: '?search=an&first=99999999' }))
    expect((realms['tenant-a'].listUsers.mock.calls[0][0] as { first: number }).first).toBeLessThanOrEqual(10000)
  })

  it('an empty or blank search returns an empty list and does not ask Keycloak (no realm dump)', async () => {
    for (const query of ['', '?search=', '?search=%20%20', '?slim=true&max=10']) {
      const res = await GET(event({ query }))
      expect(res.status).toBe(200)
      expect(((await res.json()) as { data: unknown[] }).data).toEqual([])
    }
    expect(realms['tenant-a'].listUsers).not.toHaveBeenCalled()
  })

  it('a search term over 100 characters is a 400', async () => {
    const res = await GET(event({ query: `?search=${'a'.repeat(101)}` }))
    expect(res.status).toBe(400)
    expect(realms['tenant-a'].listUsers).not.toHaveBeenCalled()
  })

  it('an export value is a 400: the e-mail export of the elections pages is not built', async () => {
    for (const query of ['?export=email', '?export=csv', '?search=an&export=email', '?export=']) {
      const res = await GET(event({ query }))
      expect(res.status, query).toBe(400)
    }
    expect(realms['tenant-a'].listUsers).not.toHaveBeenCalled()
  })
})

describe('GET /api/users: failure', () => {
  it('a Keycloak failure is a 502 that carries neither the search term nor the upstream text, and logs neither', async () => {
    realms['tenant-a'].listUsers.mockRejectedValue(new Error('upstream said: anna@example.test not reachable'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const res = await GET(event({ query: '?search=anna@example.test' }))
    expect(res.status).toBe(502)
    const text = JSON.stringify(await res.json())
    expect(text).not.toContain('anna@example.test')
    expect(JSON.stringify(err.mock.calls)).not.toContain('anna@example.test')
    err.mockRestore()
  })
})
