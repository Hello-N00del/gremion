// packages/tenant-store/src/lifecycle/governance.ts
//
// TASK-084-a: one customer's GOVERNANCE database on the dedicated
// governance-postgres server, t_<tenant hex32>__governance, and its roles:
//   g_<hex32>_owner   NOLOGIN, owns the database and every object in it (the
//                     migration runs AS the owner, through the admin pool);
//   g_<hex32>_app     LOGIN NOBYPASSRLS, SCRAM verifier; NOT a member of the
//                     owner (the service credential must neither SET ROLE to
//                     the table owner nor write the migration ledger);
//   g_<hex32>_purger  NOLOGIN, no password at rest.
// Two cluster-wide group roles (gov_app, gov_purger; NOLOGIN NOBYPASSRLS)
// carry the table grants of the migration; the customer roles inherit them.
// CONNECT on a governance database goes only to that customer's three roles.
import { tenantModuleDbName, assertTenantId } from '../names.js'
import { LifecycleError } from './guards.js'

export const GOVERNANCE_MODULE = 'governance'
/** The migration ledger of the governance chain (the runner creates it). */
export const GOVERNANCE_LEDGER = 'gov.schema_migration'

/** Cluster-wide group roles that carry the migration's table grants. */
export const GOVERNANCE_GROUP_ROLES: Readonly<{ app: 'gov_app'; purger: 'gov_purger' }> = Object.freeze({
  app: 'gov_app',
  purger: 'gov_purger',
} as const)

export interface GovernanceRoles {
  owner: string
  app: string
  purger: string
}

function assertTenant(tenantId: string): string {
  try {
    assertTenantId(tenantId)
  } catch (err) {
    throw new LifecycleError('INVALID_INPUT', (err as Error).message, { cause: err })
  }
  return tenantId.replaceAll('-', '')
}

/** t_<hex32>__governance. */
export function governanceDbName(tenantId: string): string {
  assertTenant(tenantId)
  return tenantModuleDbName(tenantId, GOVERNANCE_MODULE)
}

export function governanceRoles(tenantId: string): GovernanceRoles {
  const hex = assertTenant(tenantId)
  return { owner: `g_${hex}_owner`, app: `g_${hex}_app`, purger: `g_${hex}_purger` }
}
