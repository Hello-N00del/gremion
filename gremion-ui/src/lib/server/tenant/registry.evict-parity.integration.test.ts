import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

// The per-tenant limiter is DEFAULT OFF (rate-limit.ts: no TENANT_RATE_LIMIT_RPS
// ⇒ no bucket state at all), so the bucket-eviction case cannot be observed
// without turning it on. Widen the REAL process env rather than replacing it:
// control-db.ts and registry.ts read CONTROL_DATABASE_URL / PLATFORM_DOMAIN /
// CONFIG_PATH from process.env too (TASK-032: kit 3's $env/dynamic/private
// exposes only schema-declared vars, so the code reads process.env and a
// vi.mock of that module would be inert). vi.hoisted runs before the imports.
vi.hoisted(() => {
  process.env.TENANT_RATE_LIMIT_RPS = '1'
  process.env.TENANT_RATE_LIMIT_BURST = '20'
})

import { getControlDb } from './control-db'
import { runControlMigrations } from './control-migrations'
import {
  registerTenant, addTenantDomain, resolveTenantByHost, resolveTenantBySlug,
  evictTenantRuntime, _resetResolutionCacheForTests, _hostCacheSizeForTests,
  type TenantInput,
} from './registry'
import { checkTenantRateLimit, __resetTenantRateLimit } from './rate-limit'

const SLUG = 'rat-evictstadt'
let tenantId: string

const input: TenantInput = {
  slug: SLUG, status: 'active',
  dbConnRef: 'env:DATABASE_URL', realmName: SLUG,
  issuer: 'https://rat-evictstadt.de/auth/realms/rat-evictstadt',
  kcInternal: 'http://keycloak:8080/auth/realms/rat-evictstadt',
  kcClientId: 'gremion-admin', kcClientRef: 'env:KEYCLOAK_ADMIN_CLIENT_SECRET',
  authClientRef: 'env:AUTH_KEYCLOAK_SECRET',
  ncTarget: {}, matrixSpace: {}, domainProfile: {},
  brandRef: 'config:rat-evictstadt', blueprintRef: 'STURA_BLUEPRINT@1',
  connProfile: { perTenantMax: 2, prepare: true },
  backupKeyRef: 'env:AUTH_KEYCLOAK_SECRET',
  audiences: ['gremion-ui'],
}

beforeAll(async () => { await runControlMigrations() })
beforeEach(async () => {
  await getControlDb()`DELETE FROM tenant_domain`
  await getControlDb()`DELETE FROM tenant WHERE slug = ${SLUG}`
  const t = await registerTenant(input)
  tenantId = t.id
  _resetResolutionCacheForTests()
  __resetTenantRateLimit()
})

describe('evictTenantRuntime clears BOTH keyspaces', () => {
  it('drops the host-keyed entry, not only the slug-keyed one', async () => {
    await addTenantDomain(tenantId, 'rat-evictstadt.de', { isPrimary: true })
    await resolveTenantBySlug(SLUG)
    await resolveTenantByHost('rat-evictstadt.de')
    expect(_hostCacheSizeForTests()).toBe(1)

    evictTenantRuntime(tenantId)

    // An un-evicted host-keyed entry is a CROSS-TENANT selection: the host can
    // be re-registered to another tenant while the entry still points at this
    // one. Assert the map itself, never a return value.
    expect(_hostCacheSizeForTests()).toBe(0)
  })

  it('drops the per-tenant rate-limit bucket, so a re-registered id starts fresh', () => {
    for (let i = 0; i < 40; i++) checkTenantRateLimit(tenantId, 1_000)
    const beforeEvict = checkTenantRateLimit(tenantId, 1_000)
    expect(beforeEvict.allowed).toBe(false)   // budget is genuinely consumed

    evictTenantRuntime(tenantId)

    expect(checkTenantRateLimit(tenantId, 1_000).allowed).toBe(true)
  })
})
