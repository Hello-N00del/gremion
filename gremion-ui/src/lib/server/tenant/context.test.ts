import { describe, it, expect } from 'vitest'
import {
  getTenant,
  requireTenant,
  currentTenantId,
  getTenantOrNull,
  runWithTenant,
  type TenantContext,
} from './context'

describe('tenant context — fail-closed (no ALS store)', () => {
  it('getTenant() throws when no tenant context is active', () => {
    expect(() => getTenant()).toThrow(/no tenant context/i)
  })
  it('requireTenant() throws when no tenant context is active', () => {
    expect(() => requireTenant()).toThrow(/no tenant context/i)
  })
  it('currentTenantId() throws when no tenant context is active', () => {
    expect(() => currentTenantId()).toThrow(/no tenant context/i)
  })
  it('does NOT silently default to a tenant', () => {
    let returned: unknown = 'sentinel'
    try { returned = getTenant() } catch { returned = undefined }
    expect(returned).toBeUndefined()
  })
})

describe('tenant context — getTenantOrNull fail-OPEN contract', () => {
  it('returns null outside any context and the ctx inside runWithTenant', () => {
    expect(getTenantOrNull()).toBeNull()
    const ctx = fakeCtx('default')
    expect(runWithTenant(ctx, () => getTenantOrNull())).toBe(ctx)
  })
})

// Minimal valid context via a structural cast — this task only proves the
// carrier; field construction belongs to the resolver/rebind tasks.
function fakeCtx(id: string): TenantContext {
  return {
    id, slug: id,
    db: {} as TenantContext['db'],
    issuer: `https://${id}.example.org/auth/realms/${id}`,
    kcInternal: `http://keycloak:8080/auth/realms/${id}`,
    audiences: ['gremion-ui'],
    kcAdminClient: {} as TenantContext['kcAdminClient'],
    realmName: id, kcAdminUrl: 'http://keycloak:8080/auth',
    kcClientId: 'gremion-admin', kcClientSecretRef: `kc-${id}`,
    authExternalBase: `https://${id}.example.org/auth/realms/${id}`,
    authClientId: 'gremion-ui', authClientSecretRef: `ui-${id}`,
    brand: {} as TenantContext['brand'],
    config: {} as TenantContext['config'],
    aliasNamespace: `${id}-`, accent: null, logoUrl: null,
    configPath: `/data/${id}/config.json`,
    dbUrl: `postgres://${id}`, dbMax: 3, dbPrepare: true,
  }
}

describe('tenant context — value inside runWithTenant', () => {
  it('getTenant() returns the context set by runWithTenant', () => {
    const ctx = fakeCtx('default')
    const seen = runWithTenant(ctx, () => getTenant())
    expect(seen).toBe(ctx)
    expect(seen.id).toBe('default')
  })
  it('currentTenantId() returns the active id', () => {
    expect(runWithTenant(fakeCtx('acme'), () => currentTenantId())).toBe('acme')
  })
  it('propagates across awaited async boundaries', async () => {
    const seen = await runWithTenant(fakeCtx('acme'), async () => {
      await Promise.resolve()
      return getTenant().id
    })
    expect(seen).toBe('acme')
  })
  it('nested runWithTenant overrides then restores the outer context', () => {
    runWithTenant(fakeCtx('outer'), () => {
      expect(getTenant().id).toBe('outer')
      runWithTenant(fakeCtx('inner'), () => expect(getTenant().id).toBe('inner'))
      expect(getTenant().id).toBe('outer')
    })
  })
  it('context is cleared (throws) after runWithTenant returns', () => {
    runWithTenant(fakeCtx('default'), () => getTenant())
    expect(() => getTenant()).toThrow(/no tenant context/i)
  })
  it('returns the callback result unchanged (sync)', () => {
    expect(runWithTenant(fakeCtx('default'), () => 42)).toBe(42)
  })
})
