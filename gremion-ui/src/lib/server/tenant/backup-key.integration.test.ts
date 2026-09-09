// src/lib/server/tenant/backup-key.integration.test.ts
// P2.1c T16 — the §8.7 AUTOMATABLE assertion (the ONLY automated slice of the
// §7.9/§8.7 crypto-shred posture). Named *.integration.test.ts because the plan
// directs it to run "(TDD, integration) ... for every registry row" — it seeds
// the disposable control DB and iterates the real rows.
//
// SCOPE / what this does NOT cover (design `2026-06-08-pillar2-tenancy-design.md`
// §3-step-9 acceptance posture, R8): the crypto-shred CHAIN itself
// (delete destroys the key file FIRST, then drops DB+realm, then tombstones) and
// the "exactly ONE physical copy anywhere on disk/backup media" guarantee stay
// OPERATIONAL ACCEPTANCE (manual audit) — they cannot be proven by a test.
// This file proves only the two automatable invariants the design names:
//   1. every registry row's `backup_key_ref` resolves to EXACTLY ONE location;
//   2. a simulated registry-OWN-backup file set EXCLUDES every tenant
//      `backup_key_ref` target path (a leak would void the crypto-shred).
//
// Control-plane only (registry rows via getControlDb) — NOT a per-tenant
// data-plane test, so it deliberately does not enter a TenantContext (matches
// the sibling control-migrations / registry integration tests; the constraint-7
// runWithTenant rule applies to per-tenant DATA tests, of which this is not one).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { getControlDb } from './control-db'
import { runControlMigrations } from './control-migrations'
import { registerTenant, listTenants, type TenantInput } from './registry'
import { backupKeyLocation, registryBackupKeyLeaks } from './backup-key'

// The default tenant (env: scheme, byte-identical to register-default.ts:65).
const defaultRow: TenantInput = {
  slug: 'default', status: 'active',
  dbConnRef: 'env:DATABASE_URL', realmName: 'sturaos',
  issuer: 'https://council.example/auth/realms/sturaos',
  kcInternal: 'http://keycloak:8080/auth/realms/sturaos',
  kcClientId: 'gremion-admin', kcClientRef: 'env:KEYCLOAK_ADMIN_CLIENT_SECRET',
  authClientRef: 'env:AUTH_KEYCLOAK_SECRET',
  ncTarget: { url: 'https://council.example/cloud' },
  matrixSpace: { serverName: 'council.example', aliasNamespace: 'stura-' },
  domainProfile: { subdomain: 'default', residencyZone: 'eu' },
  brandRef: 'config:default', blueprintRef: 'STURA_BLUEPRINT@1',
  connProfile: { perTenantMax: 4, prepare: true },
  backupKeyRef: 'env:BACKUP_KEY',
  audiences: ['gremion-ui', 'gremion-mobile'],
}

// A provisioned tenant (file: scheme, byte-identical to pipeline.ts:166 shape:
// containerRef(`tenant_<slug>_backup_key`)).
function provisionedRow(slug: string): TenantInput {
  return {
    ...defaultRow,
    slug, status: 'active',
    dbConnRef: `file:/run/secrets/tenants/tenant_${slug}_db`,
    realmName: slug,
    issuer: `https://${slug}.council.example/auth/realms/${slug}`,
    kcInternal: `http://keycloak:8080/auth/realms/${slug}`,
    kcClientRef: `file:/run/secrets/tenants/tenant_${slug}_client_gremion-admin`,
    authClientRef: `file:/run/secrets/tenants/tenant_${slug}_client_gremion-ui`,
    domainProfile: { subdomain: slug, residencyZone: 'eu' },
    brandRef: `config:${slug}`,
    backupKeyRef: `file:/run/secrets/tenants/tenant_${slug}_backup_key`,
  }
}

describe('§8.7 backup-key invariants — every registry row', () => {
  beforeAll(async () => { await runControlMigrations() })
  beforeEach(async () => {
    await getControlDb()`TRUNCATE tenant, tenant_provisioning_resource RESTART IDENTITY CASCADE`
  })

  it('every backup_key_ref resolves to EXACTLY ONE canonical location', async () => {
    await registerTenant(defaultRow)
    await registerTenant(provisionedRow('t2'))
    await registerTenant(provisionedRow('verein'))

    const tenants = await listTenants()
    expect(tenants.length).toBe(3)
    for (const t of tenants) {
      const loc = backupKeyLocation(t.backupKeyRef)
      if (loc.kind === 'file') {
        // exactly-one: a single non-empty host path, no ambiguity.
        expect(loc.hostPath).toMatch(/\/tenant_[a-z0-9-]+_backup_key$/)
      } else {
        expect(loc.kind).toBe('env')
        expect(loc.envVar).toBe('BACKUP_KEY')
      }
    }
  })

  it('a simulated registry-OWN backup file set EXCLUDES every tenant backup_key_ref target (§7.9)', async () => {
    await registerTenant(defaultRow)
    await registerTenant(provisionedRow('t2'))
    await registerTenant(provisionedRow('verein'))

    const tenants = await listTenants()
    const keyRefs = tenants.map((t) => t.backupKeyRef)

    // A registry backup legitimately contains the registry dump + non-key
    // operator material; it MUST NOT contain any tenant key file.
    const cleanRegistryBackup = [
      './backups/registry/control.dump.age',
      './backups/registry/registry-meta.json',
    ]
    expect(registryBackupKeyLeaks(cleanRegistryBackup, keyRefs)).toEqual([])

    // Negative control: if a tenant key file were ever copied into the
    // registry backup, the invariant MUST flag it (crypto-shred would be void).
    const leakyRegistryBackup = [
      ...cleanRegistryBackup,
      './secrets/tenants/tenant_t2_backup_key',
    ]
    expect(registryBackupKeyLeaks(leakyRegistryBackup, keyRefs))
      .toEqual(['./secrets/tenants/tenant_t2_backup_key'])
  })

  it('fail-closed: a malformed backup_key_ref scheme throws (no silent skip)', () => {
    expect(() => backupKeyLocation('raw:hunter2')).toThrow(/unsupported backup_key_ref scheme/i)
    // a file: ref outside the per-tenant D-SECMOUNT subdir is refused upstream
    // by tenantSecretHostPath (no ambiguous second location).
    expect(() => backupKeyLocation('file:/etc/passwd')).toThrow(/tenants/)
    expect(() => backupKeyLocation('file:/run/secrets/tenants/../x')).toThrow(/tenants/)
  })
})
