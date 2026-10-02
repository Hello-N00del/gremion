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
// Closed by construction: only names the per-tenant list classes (per-tenant-env-names.js) are served
// here; a deployment-global name belongs to platformEnv, and anything else is not a service endpoint
// at all - both throw, so this can never grow into a general `process.env` accessor.
//
// It reads `process.env` at call time with a computed key (never `$env/dynamic/private`), so the seam
// survives a SvelteKit major unchanged (R25-3). Replacing its callers with a resolved-tenant carrier is
// TASK-043's and the module SDK's (TASK-125) work; the callers are the ledger of what is left.
import { isPerTenantEnvName } from './per-tenant-env-names.js'

/**
 * Read one deployment-wide service-endpoint variable. Returns `undefined` when it is unset (the caller
 * supplies its own fallback). Throws on a name that is not a per-tenant-classed service endpoint.
 */
export function serviceEnv(name: string): string | undefined {
  if (!isPerTenantEnvName(name)) {
    throw new Error(
      `serviceEnv: ${name} is not a service-endpoint variable (the per-tenant list in per-tenant-env-names.js); a deployment-global name is read through platformEnv`,
    )
  }
  return process.env[name]
}
