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
  resolveTenantByHost,
  getTenantStatusByHost,
  updateTenantStatus,
  _resetResolutionCacheForTests,
  clearHostResolutionCache,
  _hostCacheSizeForTests,
  type TenantInput,
} from './registry'
import { reservedPlatformHosts } from './reserved-hosts'

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

// §T.1 reserved-host refusal. On addTenantDomain, not only in a control-plane
// form, so no surviving library caller can bypass it (spec A §H.2: before the
// DNS pre-flight, which cannot catch names already pointing at our own edge).
describe('reserved platform hosts are refused by addTenantDomain', () => {
  it('refuses each of the nine names under PLATFORM_DOMAIN, with ONE error shape', async () => {
    for (const host of reservedPlatformHosts(process.env.PLATFORM_DOMAIN!)) {
      await expect(addTenantDomain(tenantId, host)).rejects.toThrow(
        new RegExp(`reserved platform host: ${host.replace(/\./g, '\.')}`),
      )
    }
    expect(await listTenantDomains(tenantId)).toEqual([])
  })

  // `_dmarc.<apex>` cannot survive normaliseHost (host.ts:43 rejects the
  // underscore), so it is the one reserved name that would get the WRONG error
  // — "not a valid host" — if the reserved check ran after normalisation.
  it('reports _dmarc.<apex> as RESERVED, never as malformed', async () => {
    const dmarc = `_dmarc.${process.env.PLATFORM_DOMAIN}`
    await expect(addTenantDomain(tenantId, dmarc)).rejects.toThrow(
      new RegExp(`reserved platform host: ${dmarc.replace(/\./g, '\.')}`),
    )
    await expect(addTenantDomain(tenantId, dmarc)).rejects.not.toThrow(/is not a valid host/)
  })

  it('still accepts an ordinary tenant host under the same apex', async () => {
    const d = await addTenantDomain(tenantId, `musterstadt.${process.env.PLATFORM_DOMAIN}`)
    expect(d.host).toBe(`musterstadt.${process.env.PLATFORM_DOMAIN}`)
  })
})

// Registry-row post-condition #1: a tenant is created, a host added, and the
// tenant is resolved BY HOST.
describe('host-keyed resolution', () => {
  beforeEach(() => { _resetResolutionCacheForTests() })

  it('resolves the tenant from the whole host, with primaryHost on the context', async () => {
    await addTenantDomain(tenantId, 'rat-musterstadt.de', { isPrimary: true })
    const ctx = await resolveTenantByHost('rat-musterstadt.de')
    expect(ctx).not.toBeNull()
    expect(ctx!.id).toBe(tenantId)
    expect(ctx!.slug).toBe(SLUG)
    expect(ctx!.primaryHost).toBe('rat-musterstadt.de')
  })

  it('accepts every spelling the write path accepts — one normaliser, both sides', async () => {
    await addTenantDomain(tenantId, 'Rat-Musterstadt.DE', { isPrimary: true })
    for (const raw of ['rat-musterstadt.de', 'RAT-MUSTERSTADT.DE', 'rat-musterstadt.de.',
                       'rat-musterstadt.de:443']) {
      expect((await resolveTenantByHost(raw))!.id).toBe(tenantId)
    }
  })

  it('returns null for an unregistered host and for a malformed one — never a fallback tenant', async () => {
    await addTenantDomain(tenantId, 'rat-musterstadt.de', { isPrimary: true })
    expect(await resolveTenantByHost('attacker.example')).toBeNull()
    expect(await resolveTenantByHost('client.example, rat-musterstadt.de')).toBeNull()
    expect(await resolveTenantByHost(undefined)).toBeNull()
  })

  it('getTenantStatusByHost tells suspended from unknown without touching the data plane', async () => {
    await addTenantDomain(tenantId, 'rat-musterstadt.de', { isPrimary: true })
    await updateTenantStatus(tenantId, 'suspended')
    expect(await resolveTenantByHost('rat-musterstadt.de')).toBeNull()
    expect(await getTenantStatusByHost('rat-musterstadt.de')).toBe('suspended')
    expect(await getTenantStatusByHost('attacker.example')).toBeNull()
    await updateTenantStatus(tenantId, 'active')
  })

  // The "*" arm B19-internal-api-evict-and-modules' evictAllTenants binds to
  // (spec B l.385). Per-tenant eviction is evictTenantRuntime; this clears the
  // whole host keyspace, including entries whose tenant row is already gone.
  it('clearHostResolutionCache empties the host-keyed cache wholesale', async () => {
    await addTenantDomain(tenantId, 'rat-musterstadt.de', { isPrimary: true })
    await resolveTenantByHost('rat-musterstadt.de')
    expect(_hostCacheSizeForTests()).toBe(1)
    clearHostResolutionCache()
    expect(_hostCacheSizeForTests()).toBe(0)
  })
})

// The registry row for this unit, asserted in one place.
describe('B8 post-condition', () => {
  // The host-keyed cache survives the outer beforeEach (which only touches the
  // control DB) and each pass seeds a NEW tenant id, so an entry left by an
  // earlier describe would resolve this host to a tenant that no longer exists.
  beforeEach(() => {
    _resetResolutionCacheForTests()
  })

  it('a tenant is created, a host added, and the tenant resolved BY HOST', async () => {
    const d = await addTenantDomain(tenantId, 'rat-musterstadt.de', { isPrimary: true })
    const stored = await getControlDb()<Array<{ host: string; is_primary: boolean }>>`
      SELECT host, is_primary FROM tenant_domain WHERE tenant_id = ${tenantId}`
    expect(stored).toEqual([{ host: 'rat-musterstadt.de', is_primary: true }])
    // Byte-for-byte: the key the write path stored is the key the read path uses.
    expect((await resolveTenantByHost(d.host))!.id).toBe(tenantId)
  })

  it('every one of the nine reserved names is refused and writes no row', async () => {
    for (const host of reservedPlatformHosts(process.env.PLATFORM_DOMAIN!)) {
      await expect(addTenantDomain(tenantId, host)).rejects.toThrow(/reserved platform host:/)
    }
    const rows = await getControlDb()<Array<{ c: number }>>`
      SELECT count(*)::int AS c FROM tenant_domain`
    expect(rows[0].c).toBe(0)
  })

  it('every registry write path normalises through assertHost', async () => {
    for (const call of [
      () => addTenantDomain(tenantId, 'client.example, rat-musterstadt.de'),
      () => removeTenantDomain(tenantId, 'evil.com:80@x'),
      () => setPrimaryDomain(tenantId, 'tenant..de'),
    ]) {
      await expect(call()).rejects.toThrow(/is not a valid host/)
    }
  })
})
