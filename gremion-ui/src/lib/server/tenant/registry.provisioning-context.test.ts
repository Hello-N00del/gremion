// TASK-043 Q21: contextForProvisioningTenant is the ONE way into a customer's
// context before it is active, and it refuses every other status.
import { describe, expect, it } from 'vitest'
import { contextForProvisioningTenant, type Tenant } from './registry'

function row(status: Tenant['status']): Tenant {
  return {
    id: '01927f00-0000-7000-8000-000000000001',
    slug: 'musterstadt',
    status,
    dbConnRef: 'file:/run/secrets/tenants/tenant_musterstadt_db',
    realmName: 'musterstadt',
    issuer: 'https://rat.musterstadt.example/auth/realms/musterstadt',
    kcInternal: 'https://keycloak:8443/auth/realms/musterstadt',
    kcClientId: 'gremion-admin',
    kcClientRef: 'file:/run/secrets/tenants/tenant_musterstadt_client_gremion-admin',
    authClientRef: 'file:/run/secrets/tenants/tenant_musterstadt_client_gremion-ui',
    ncTarget: {},
    matrixSpace: {},
    domainProfile: {},
    brandRef: 'config:musterstadt',
    blueprintRef: 'STURA_BLUEPRINT@1',
    connProfile: {},
    backupKeyRef: 'file:/run/secrets/tenants/tenant_musterstadt_backup_key',
    audiences: ['gremion-ui', 'gremion-mobile'],
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Tenant
}

describe('contextForProvisioningTenant (Q21)', () => {
  it.each(['active', 'suspended', 'deleting', 'deleted'] as const)('refuses a %s row before touching anything', async (status) => {
    await expect(contextForProvisioningTenant(row(status))).rejects.toThrow(/not provisioning/)
  })
})
