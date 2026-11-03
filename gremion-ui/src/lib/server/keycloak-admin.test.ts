import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const envMock: Record<string, string> = {}
vi.mock('$env/dynamic/private', () => ({ env: envMock }))
vi.mock('$lib/server/tenant/secrets', () => ({ resolveSecret: (ref: string) => `secret-for-${ref}` }))

type TenantKc = { id: string; realmName: string; kcAdminUrl: string; kcClientId: string; kcClientSecretRef: string }
const tenantA: TenantKc = { id: 'a', realmName: 'tenant-a', kcAdminUrl: 'http://keycloak:8080/auth', kcClientId: 'gremion-admin', kcClientSecretRef: 'kc-a' }
const tenantB: TenantKc = { id: 'b', realmName: 'tenant-b', kcAdminUrl: 'http://keycloak:8080/auth', kcClientId: 'gremion-admin', kcClientSecretRef: 'kc-b' }

describe('getKeycloakAdminClient(tenant) — per-tenant factory (keyed by tenant.id)', () => {
  beforeEach(async () => { vi.resetModules(); (await import('./keycloak-admin')).__resetKcAdminCache() })

  it('returns the SAME client for the same tenant', async () => {
    const { getKeycloakAdminClient } = await import('./keycloak-admin')
    expect(getKeycloakAdminClient(tenantA)).toBe(getKeycloakAdminClient(tenantA))
  })
  it('returns DIFFERENT clients for different tenants', async () => {
    const { getKeycloakAdminClient } = await import('./keycloak-admin')
    expect(getKeycloakAdminClient(tenantA)).not.toBe(getKeycloakAdminClient(tenantB))
  })
  it('binds the client to the tenant realm + resolved secret', async () => {
    const { getKeycloakAdminClient } = await import('./keycloak-admin')
    const c = getKeycloakAdminClient(tenantA) as unknown as { realm: string; clientId: string; clientSecret: string; adminUrl: string }
    expect(c.realm).toBe('tenant-a'); expect(c.clientId).toBe('gremion-admin')
    expect(c.clientSecret).toBe('secret-for-kc-a'); expect(c.adminUrl).toBe('http://keycloak:8080/auth')
  })
  // P2.1b T6 (D-JWKS/#256-6): the cache key is the canonical tenant.id, NOT the
  // realm name — two tenants may share a realm and must not share a client.
  it('two tenants sharing the SAME realm get DISTINCT clients (keyed by tenant.id)', async () => {
    const { getKeycloakAdminClient } = await import('./keycloak-admin')
    const sharedA: TenantKc = { id: 'tid-a', realmName: 'shared', kcAdminUrl: 'http://keycloak:8080/auth', kcClientId: 'gremion-admin', kcClientSecretRef: 'kc-a' }
    const sharedB: TenantKc = { id: 'tid-b', realmName: 'shared', kcAdminUrl: 'http://keycloak:8080/auth', kcClientId: 'gremion-admin', kcClientSecretRef: 'kc-b' }
    expect(getKeycloakAdminClient(sharedA)).not.toBe(getKeycloakAdminClient(sharedB))
  })
  it('evictKeycloakAdminClient(tenantId): evicted tenant re-creates, others keep theirs', async () => {
    const { getKeycloakAdminClient, evictKeycloakAdminClient } = await import('./keycloak-admin')
    const a1 = getKeycloakAdminClient(tenantA)
    const b1 = getKeycloakAdminClient(tenantB)
    evictKeycloakAdminClient(tenantA.id)
    expect(getKeycloakAdminClient(tenantA)).not.toBe(a1)
    expect(getKeycloakAdminClient(tenantB)).toBe(b1)
  })
  it('default tenant maps to today env values byte-identically (golden)', async () => {
    const { getKeycloakAdminClient } = await import('./keycloak-admin')
    const dflt: TenantKc = { id: 'default', realmName: 'gremion-test', kcAdminUrl: 'http://keycloak:8080/auth', kcClientId: 'gremion-admin', kcClientSecretRef: 'kc-default' }
    const c = getKeycloakAdminClient(dflt) as unknown as { realm: string; clientId: string; adminUrl: string }
    expect(c.realm).toBe('gremion-test'); expect(c.clientId).toBe('gremion-admin'); expect(c.adminUrl).toBe('http://keycloak:8080/auth')
  })
})

describe('KeycloakAdminClient.listRealmRoleMembers', () => {
  const user = (n: number) => ({
    id: `u${n}`, username: `user${n}`, email: `user${n}@example.test`,
    firstName: 'F', lastName: 'L', enabled: true, emailVerified: true
  })
  const tokenOk = () => new Response(JSON.stringify({ access_token: 't', expires_in: 300 }), { status: 200 })

  async function clientWithFetch(roleUsers: Array<ReturnType<typeof user>>) {
    const urls: string[] = []
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/protocol/openid-connect/token')) return tokenOk()
      urls.push(url)
      const u = new URL(url)
      const first = Number(u.searchParams.get('first'))
      const max = Number(u.searchParams.get('max'))
      return new Response(JSON.stringify(roleUsers.slice(first, first + max)), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { KeycloakAdminClient } = await import('./keycloak-admin')
    return { client: new KeycloakAdminClient('http://kc.test/auth', 'realm-x', 'cid', 'sec'), urls, fetchMock }
  }

  beforeEach(() => { vi.resetModules() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('paging: 450 members across 3 pages are all returned', async () => {
    const all = Array.from({ length: 450 }, (_, i) => user(i))
    const { client, urls } = await clientWithFetch(all)
    const members = await client.listRealmRoleMembers('council-admin')
    expect(members).toHaveLength(450)
    expect(new Set(members.map((m) => m.id)).size).toBe(450)
    expect(urls).toHaveLength(3)
    expect(urls.map((u) => new URL(u).searchParams.get('first'))).toEqual(['0', '200', '400'])
    expect(urls.map((u) => new URL(u).searchParams.get('max'))).toEqual(['200', '200', '200'])
    expect(new URL(urls[0]!).pathname).toBe('/auth/admin/realms/realm-x/roles/council-admin/users')
  })

  it('an exact multiple of the page size ends on the empty page', async () => {
    const all = Array.from({ length: 400 }, (_, i) => user(i))
    const { client, urls } = await clientWithFetch(all)
    expect(await client.listRealmRoleMembers('vorstand')).toHaveLength(400)
    expect(urls).toHaveLength(3)
  })

  it('an empty role yields an empty list after one request', async () => {
    const { client, urls } = await clientWithFetch([])
    expect(await client.listRealmRoleMembers('vorstand')).toEqual([])
    expect(urls).toHaveLength(1)
  })

  it('a role name with a slash is URL-encoded into one path segment', async () => {
    const { client, urls } = await clientWithFetch([user(1)])
    await client.listRealmRoleMembers('a/b c')
    expect(new URL(urls[0]!).pathname).toBe('/auth/admin/realms/realm-x/roles/a%2Fb%20c/users')
  })

  it('rejects dot segments as role names before any request leaves', async () => {
    const { client, fetchMock } = await clientWithFetch([])
    await expect(client.listRealmRoleMembers('..')).rejects.toThrow('Invalid Keycloak id')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a non-2xx answer rejects with the Keycloak status', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) =>
      String(input).includes('/protocol/openid-connect/token') ? tokenOk() : new Response('boom', { status: 500 })))
    const { KeycloakAdminClient } = await import('./keycloak-admin')
    const client = new KeycloakAdminClient('http://kc.test/auth', 'realm-x', 'cid', 'sec')
    await expect(client.listRealmRoleMembers('vorstand')).rejects.toMatchObject({ status: 500 })
  })
})
