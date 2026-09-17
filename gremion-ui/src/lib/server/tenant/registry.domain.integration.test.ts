import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { getControlDb } from './control-db'
import { runControlMigrations } from './control-migrations'
import {
  registerTenant,
  listTenantDomains,
  listAllTenantDomains,
  primaryHostForTenant,
  type TenantInput,
} from './registry'

const SLUG = 'rat-musterstadt'
let tenantId: string

/** A complete TenantInput (registry.TenantInput = every Tenant field but the
 *  generated ones), with secret refs the integration env can actually resolve. */
function inputFor(slug: string): TenantInput {
  return {
    slug,
    status: 'active',
    dbConnRef: 'env:DATABASE_URL',
    realmName: slug,
    issuer: `https://${slug}.de/auth/realms/${slug}`,
    kcInternal: `http://keycloak:8080/auth/realms/${slug}`,
    kcClientId: 'gremion-admin',
    kcClientRef: 'env:KEYCLOAK_ADMIN_CLIENT_SECRET',
    authClientRef: 'env:AUTH_KEYCLOAK_SECRET',
    ncTarget: {},
    matrixSpace: {},
    domainProfile: {},
    brandRef: `config:${slug}`,
    blueprintRef: 'STURA_BLUEPRINT@1',
    connProfile: { perTenantMax: 2, prepare: true },
    backupKeyRef: 'env:AUTH_KEYCLOAK_SECRET',
    audiences: ['gremion-ui'],
  }
}

async function seedTenant(): Promise<string> {
  const t = await registerTenant(inputFor(SLUG))
  return t.id
}

beforeAll(async () => { await runControlMigrations() })
beforeEach(async () => {
  await getControlDb()`DELETE FROM tenant_domain`
  await getControlDb()`DELETE FROM tenant WHERE slug = ${SLUG}`
  tenantId = await seedTenant()
})

describe('tenant_domain read accessors', () => {
  it('primaryHostForTenant is null for a tenant with no host — never a synthesised one', async () => {
    expect(await primaryHostForTenant(tenantId)).toBeNull()
  })

  it('lists a tenant’s hosts primary-first then alphabetical', async () => {
    await getControlDb()`
      INSERT INTO tenant_domain (host, tenant_id, is_primary) VALUES
        ('zzz.rat-musterstadt.de', ${tenantId}, false),
        ('aaa.rat-musterstadt.de', ${tenantId}, false),
        ('rat-musterstadt.de',     ${tenantId}, true)`
    const hosts = (await listTenantDomains(tenantId)).map((d) => d.host)
    expect(hosts).toEqual(['rat-musterstadt.de', 'aaa.rat-musterstadt.de', 'zzz.rat-musterstadt.de'])
    expect(await primaryHostForTenant(tenantId)).toBe('rat-musterstadt.de')
  })

  it('listAllTenantDomains reads the whole table in ONE statement', async () => {
    await getControlDb()`
      INSERT INTO tenant_domain (host, tenant_id, is_primary)
      VALUES ('rat-musterstadt.de', ${tenantId}, true)`
    const all = await listAllTenantDomains()
    expect(all.map((d) => d.host)).toEqual(['rat-musterstadt.de'])
    expect(all[0].tenantId).toBe(tenantId)
    expect(all[0].isPrimary).toBe(true)
    expect(all[0].verifiedAt).toBeNull()
  })

  it('rejects a malformed tenant id before any SQL runs', async () => {
    await expect(listTenantDomains('not-a-uuid')).rejects.toThrow(
      'listTenantDomains: "not-a-uuid" is not a tenant id (uuid)',
    )
  })
})
