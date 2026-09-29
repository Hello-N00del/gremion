// tests/integration/create-test-tenant.ts
//
// TASK-042 (spec B section T.2): the kernel boots with zero tenants and no
// suite gets a registry tenant for free any more. This factory is the ONLY
// way a kernel suite creates one. It is an accepted PARTIAL MIRROR of the
// provisioner's registry writes (provisioner/pipeline.ts, TASK-043 re-points it
// at tenant-create): the `tenant` row plus its PRIMARY `tenant_domain` host,
// nothing else - no realm, no database, no secret file.
//
// The data plane is the suite's own DATABASE_URL (`env:DATABASE_URL`), and the
// issuer is minted from the tenant host exactly like the provisioner mints it
// (https://<host>/auth/realms/<realm>), so assertIssMatch holds by
// construction for a token a suite signs for that issuer.
import { registerTenant, addTenantDomain, type TenantInput } from '$lib/server/tenant/registry'

export interface TestTenantOpts {
  slug: string
  /** The tenant's primary host; the resolver selects the tenant by it. */
  host: string
  /** Keycloak realm; defaults to the slug. */
  realmName?: string
  status?: 'active' | 'suspended'
  /** Data-plane connection ref; defaults to the suite's env:DATABASE_URL. */
  dbConnRef?: string
}

export interface TestTenant {
  id: string
  slug: string
  host: string
  realmName: string
  issuer: string
}

export async function createTestTenant(opts: TestTenantOpts): Promise<TestTenant> {
  const realmName = opts.realmName ?? opts.slug
  const issuer = `https://${opts.host}/auth/realms/${realmName}`
  const input: TenantInput = {
    slug: opts.slug,
    status: opts.status ?? 'active',
    dbConnRef: opts.dbConnRef ?? 'env:DATABASE_URL',
    realmName,
    issuer,
    kcInternal: `https://keycloak:8443/auth/realms/${realmName}`,
    kcClientId: 'gremion-admin',
    kcClientRef: 'env:KEYCLOAK_ADMIN_CLIENT_SECRET',
    authClientRef: 'env:AUTH_KEYCLOAK_SECRET',
    ncTarget: {},
    matrixSpace: { aliasNamespace: `${opts.slug}-` },
    domainProfile: { residencyZone: 'eu' },
    brandRef: `config:${opts.slug}`,
    blueprintRef: 'STURA_BLUEPRINT@1',
    connProfile: { perTenantMax: 4, prepare: true },
    backupKeyRef: 'env:BACKUP_KEY',
    audiences: ['gremion-ui', 'gremion-mobile'],
  }
  const t = await registerTenant(input)
  const domain = await addTenantDomain(t.id, opts.host, { isPrimary: true })
  return { id: t.id, slug: t.slug, host: domain.host, realmName, issuer }
}
