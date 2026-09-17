import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { getControlDb } from './control-db'
import { runControlMigrations } from './control-migrations'
import {
  registerTenant,
  listTenantDomains,
  listAllTenantDomains,
  primaryHostForTenant,
  addTenantDomain,
  removeTenantDomain,
  setPrimaryDomain,
  TENANT_EVICT_CHANNEL,
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
  await getControlDb()`DELETE FROM tenant WHERE slug IN (${SLUG}, 'rat-anderstadt')`
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

describe('tenant_domain write accessors', () => {
  it('addTenantDomain normalises on write, so the stored key is the resolver’s key', async () => {
    const d = await addTenantDomain(tenantId, '  Rat-Musterstadt.DE.  ', { isPrimary: true })
    expect(d.host).toBe('rat-musterstadt.de')
    expect(await primaryHostForTenant(tenantId)).toBe('rat-musterstadt.de')
  })

  it('refuses a host another tenant owns, naming that tenant', async () => {
    await addTenantDomain(tenantId, 'rat-musterstadt.de', { isPrimary: true })
    const other = await registerTenant(inputFor('rat-anderstadt'))
    await expect(addTenantDomain(other.id, 'rat-musterstadt.de')).rejects.toThrow(
      /already registered to tenant "rat-musterstadt"/,
    )
    await getControlDb()`DELETE FROM tenant WHERE slug = 'rat-anderstadt'`
  })

  it('clears-then-sets the primary in ONE transaction', async () => {
    await addTenantDomain(tenantId, 'alt.rat-musterstadt.de', { isPrimary: true })
    await addTenantDomain(tenantId, 'rat-musterstadt.de', { isPrimary: true })
    const primaries = (await listTenantDomains(tenantId)).filter((d) => d.isPrimary)
    expect(primaries.map((d) => d.host)).toEqual(['rat-musterstadt.de'])
  })

  it('setPrimaryDomain refuses a host the tenant does not own and rolls the clear back', async () => {
    await addTenantDomain(tenantId, 'rat-musterstadt.de', { isPrimary: true })
    await expect(setPrimaryDomain(tenantId, 'nope.example')).rejects.toThrow(
      /is not registered to tenant/,
    )
    expect(await primaryHostForTenant(tenantId)).toBe('rat-musterstadt.de')
  })

  it('removeTenantDomain refuses to drop the primary while other hosts remain', async () => {
    await addTenantDomain(tenantId, 'rat-musterstadt.de', { isPrimary: true })
    await addTenantDomain(tenantId, 'alt.rat-musterstadt.de')
    await expect(removeTenantDomain(tenantId, 'rat-musterstadt.de')).rejects.toThrow(
      /PRIMARY host and the tenant has other hosts/,
    )
    expect(await primaryHostForTenant(tenantId)).toBe('rat-musterstadt.de')
  })

  // §T.1 post-condition: a host mutation and its eviction notice commit or roll
  // back TOGETHER. pg_notify runs inside the same sql.begin as the write, so a
  // refused write must deliver NO notice at all.
  it('the write and its tenant_evict notice are atomic', async () => {
    const notices: string[] = []
    const listener = await getControlDb().listen(TENANT_EVICT_CHANNEL, (p) => { notices.push(p) })
    try {
      await addTenantDomain(tenantId, 'rat-musterstadt.de', { isPrimary: true })
      await new Promise((r) => setTimeout(r, 200))
      expect(notices).toEqual([tenantId])

      notices.length = 0
      await expect(addTenantDomain(tenantId, 'not a host')).rejects.toThrow(/is not a valid host/)
      await expect(setPrimaryDomain(tenantId, 'nope.example')).rejects.toThrow(/is not registered/)
      await new Promise((r) => setTimeout(r, 200))
      expect(notices).toEqual([])
    } finally {
      await listener.unlisten()
    }
  })
})
