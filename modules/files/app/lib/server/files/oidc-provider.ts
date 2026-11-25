// src/lib/server/files/oidc-provider.ts
// The numeric user_oidc provider id the Nextcloud accounts of a customer are created under.
//
// The provider belongs to the customer's realm. The primary customer's provider is the one the install's
// NEXTCLOUD_OIDC_PROVIDER_ID names (default 1). A customer on a secondary host has a provider of its own,
// whose id the wire records in the customer's registry row (nc_target.providerId) and the tenant context
// carries as services.ncProviderId. Without it the customer keeps the env value, exactly as before.
import { serviceEnv } from '$lib/server/env/service-env'
import { getTenantOrNull, type TenantContext } from '$lib/server/tenant/context'

/** The provider id for `tenant` (default: the tenant of the current scope, none outside one). */
export function oidcProviderIdFor(tenant: Pick<TenantContext, 'services'> | null = getTenantOrNull()): number {
  return tenant?.services?.ncProviderId ?? Number(serviceEnv('NEXTCLOUD_OIDC_PROVIDER_ID') ?? '1')
}
