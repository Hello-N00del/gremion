import { describe, it, expect, beforeEach, vi } from 'vitest'

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
    const dflt: TenantKc = { id: 'default', realmName: 'sturaos', kcAdminUrl: 'http://keycloak:8080/auth', kcClientId: 'gremion-admin', kcClientSecretRef: 'kc-default' }
    const c = getKeycloakAdminClient(dflt) as unknown as { realm: string; clientId: string; adminUrl: string }
    expect(c.realm).toBe('sturaos'); expect(c.clientId).toBe('gremion-admin'); expect(c.adminUrl).toBe('http://keycloak:8080/auth')
  })
})
