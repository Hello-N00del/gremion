// src/lib/server/tenant/default-tenant.ts
// Sync ConfigTenant for OUT-OF-REQUEST readConfig callers (boot SMTP, audit
// interval). NOT a full TenantContext and NOT in context.ts (which stays
// env-free). Reads env.CONFIG_PATH only — covered by the env-guard allowlist
// (src/lib/server/tenant/). For out-of-request DATA-PLANE work, resolve a full
// default TenantContext via resolveTenantBySlug('default') + runWithTenant.
import { env } from '$env/dynamic/private'
import type { ConfigTenant } from '$lib/server/config'
export const DEFAULT_TENANT: ConfigTenant = {
  id: 'default',
  configPath: env.CONFIG_PATH ?? '/app/config/config.json',
}
