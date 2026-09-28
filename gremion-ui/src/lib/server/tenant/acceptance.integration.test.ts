import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { getControlDb } from './control-db'
import { runControlMigrations } from './control-migrations'
import { createTestTenant } from '../../../../tests/integration/create-test-tenant'
import { registerTenant } from './registry'
import { resolveTenantBySlug, _resetResolutionCacheForTests } from './registry'
import { runWithTenant, getTenant, currentTenantId, _getAls } from './context'
import { assertIssMatch } from './iss-match'

describe('P2.1a acceptance', () => {
  beforeAll(async () => { await runControlMigrations() })
  beforeEach(async () => {
    await getControlDb()`TRUNCATE tenant, tenant_provisioning_resource RESTART IDENTITY CASCADE`
    // T8: re-registered rows get NEW tenant ids — drop cached resolutions.
    _resetResolutionCacheForTests()
  })

  it('ALS fail-closed: accessors throw with no active tenant', () => {
    // The shared integration harness (tests/integration/setup.ts) enterWith()s a
    // DEFAULT_TEST_TENANT before each test so legacy single-tenant data-plane
    // tests have a context. To assert the fail-closed contract — accessors THROW
    // when NO tenant is active — we must run the assertions OUTSIDE any store.
    // _getAls().exit(fn) runs fn with the store cleared (it does NOT weaken the
    // assertion; it restores the precondition the harness removed).
    _getAls().exit(() => {
      expect(() => getTenant()).toThrow(/no tenant context/i)
      expect(() => currentTenantId()).toThrow(/no tenant context/i)
    })
  })

  // TASK-042: there is no deployment-derived tenant #1; a fixture tenant made by
  // createTestTenant resolves to ITS realm and ITS host-minted issuer.
  it('a registry tenant resolves to its own realm + issuer (golden)', async () => {
    const t = await createTestTenant({ slug: 'tenant-a', host: 'tenant-a.example.test', realmName: 'gremion' })
    const ctx = await resolveTenantBySlug('tenant-a')
    expect(ctx).not.toBeNull()
    expect(ctx!.realmName).toBe('gremion')
    expect(ctx!.issuer).toBe(t.issuer)
    expect(ctx!.issuer).toBe('https://tenant-a.example.test/auth/realms/gremion')
    runWithTenant(ctx!, () => { expect(currentTenantId()).toBe(ctx!.id) })
  })

  it('cross-tenant iss-replay is rejected by assertIssMatch (red->green proof)', async () => {
    await createTestTenant({ slug: 'tenant-a', host: 'tenant-a.example.test' }) // tenant A -> its own issuer
    await registerTenant({
      slug: 'tenant-b', status: 'active', dbConnRef: 'env:DATABASE_URL',
      realmName: 'tenant-b', issuer: 'https://council.example/auth/realms/tenant-b',
      kcInternal: 'http://keycloak:8080/auth/realms/tenant-b', kcClientId: 'gremion-admin',
      kcClientRef: 'env:KEYCLOAK_ADMIN_CLIENT_SECRET', authClientRef: 'env:AUTH_KEYCLOAK_SECRET',
      ncTarget: {}, matrixSpace: { aliasNamespace: 'b-' },
      domainProfile: {}, brandRef: 'config:tenant-b', blueprintRef: 'STURA_BLUEPRINT@1',
      connProfile: { perTenantMax: 4, prepare: true }, backupKeyRef: 'env:BACKUP_KEY', audiences: ['gremion-ui'],
    })
    const a = await resolveTenantBySlug('tenant-a')
    const b = await resolveTenantBySlug('tenant-b')
    // A token minted for A's realm, replayed against B's host -> rejected.
    expect(assertIssMatch({ tokenIss: a!.issuer, tenantIssuer: b!.issuer })).toBe(false)
    // A token for B's own realm on B's host -> accepted.
    expect(assertIssMatch({ tokenIss: b!.issuer, tenantIssuer: b!.issuer })).toBe(true)
  })

  it('distinct tenants resolve to distinct pools (no shared connection)', async () => {
    await createTestTenant({ slug: 'tenant-a', host: 'tenant-a.example.test' })
    await registerTenant({
      slug: 'tenant-c', status: 'active', dbConnRef: 'env:DATABASE_URL', realmName: 'tenant-c',
      issuer: 'https://council.example/auth/realms/tenant-c', kcInternal: 'http://keycloak:8080/auth/realms/tenant-c',
      kcClientId: 'gremion-admin', kcClientRef: 'env:KEYCLOAK_ADMIN_CLIENT_SECRET',
      authClientRef: 'env:AUTH_KEYCLOAK_SECRET', ncTarget: {}, matrixSpace: {},
      domainProfile: {}, brandRef: 'config:tenant-c', blueprintRef: 'STURA_BLUEPRINT@1',
      connProfile: { perTenantMax: 4, prepare: true }, backupKeyRef: 'env:BACKUP_KEY', audiences: ['gremion-ui'],
    })
    const a = await resolveTenantBySlug('tenant-a')
    const c = await resolveTenantBySlug('tenant-c')
    expect(a!.db).not.toBe(c!.db) // distinct pool objects keyed by canonical id
  })
})
