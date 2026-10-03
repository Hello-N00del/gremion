// src/lib/server/env/service-env.ts
//
// TASK-205 (Q5): the ONE reader of deployment-wide SERVICE-ENDPOINT defaults for the module
// in-process halves (the Nextcloud WebDAV/CalDAV endpoint and its credentials, the Matrix, Helios and
// LiveKit endpoints, the shared CalDAV user).
//
// platformEnv (./platform-env.ts) refuses exactly these names, by design: under TASK-042 no tenant is
// special, so a value that CAN differ per tenant is resolved from the tenant (TenantServices on the
// request's TenantContext, a tenant's own config) and never assumed from the process. Until the
// tenant-level carriers exist for every endpoint a module needs, the module reads
// `tenant value ?? serviceEnv(NAME)`: this seam is that fallback tier, the successor of the deleted
// default-tenant env reader without any notion of a default tenant in its contract. It is the same single instance for
// every tenant, so it can never be mistaken for a tenant-specific read.
//
// Closed by an explicit list: only the names in service-endpoint-names.js are served. That list is a
// strict subset of the per-tenant names - the tenant's database URL, config path, realm, admin URL and
// OIDC client credentials are per-tenant too but are never served here (verifier r1 MEDIUM: serving the
// whole per-tenant class re-opened the process-wide reads TASK-042 removed). A deployment-global name
// belongs to platformEnv; anything else throws, so this can never grow into a general `process.env`
// accessor.
//
// It reads `process.env` at call time with a computed key (never `$env/dynamic/private`), so the seam
// survives a SvelteKit major unchanged (R25-3). The computed key is invisible to the env.X pattern of
// scripts/check-tenant-env-guard.mjs, so that guard reads the serviceEnv('X') CALL SITES instead (a
// non-endpoint literal or a computed name fails the build) and lists this file in its allowlist by name.
// Replacing its callers with a resolved-tenant carrier is TASK-043's and the module SDK's (TASK-125)
// work; the callers are the ledger of what is left.
import { isServiceEndpointName } from './service-endpoint-names.js'

/**
 * Read one deployment-wide service-endpoint variable. Returns `undefined` when it is unset (the caller
 * supplies its own fallback). Throws on a name that is not in the service-endpoint list.
 */
export function serviceEnv(name: string): string | undefined {
  if (!isServiceEndpointName(name)) {
    throw new Error(
      `serviceEnv: ${name} is not a service-endpoint variable (the list in service-endpoint-names.js); a tenant-scoped name is resolved from the tenant, a deployment-global name is read through platformEnv`,
    )
  }
  return process.env[name]
}
