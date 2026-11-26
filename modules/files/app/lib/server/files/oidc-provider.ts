// src/lib/server/files/oidc-provider.ts
// The numeric user_oidc provider id the Nextcloud accounts of a customer are created under.
//
// The provider belongs to the customer's realm. The primary customer's provider is the one the install's
// NEXTCLOUD_OIDC_PROVIDER_ID names (default 1). A customer on a secondary host has a provider of its own;
// if the customer's registry row names its id (nc_target.providerId), the tenant context carries it as
// services.ncProviderId and it wins. Nothing writes that key for now (the wire refuses NC_PROVIDER_PER_CUSTOMER=on,
// docs/ops/pilot-services.md says how to clear a row that holds one). Without it (the primary customer, every
// install with the switch off) the customer keeps the env value, exactly as before.
import { serviceEnv } from '$lib/server/env/service-env'
import { getTenantOrNull, type TenantContext } from '$lib/server/tenant/context'

/** The provider id for `tenant` (default: the tenant of the current scope, none outside one). */
export function oidcProviderIdFor(tenant: Pick<TenantContext, 'services'> | null = getTenantOrNull()): number {
  return tenant?.services?.ncProviderId ?? Number(serviceEnv('NEXTCLOUD_OIDC_PROVIDER_ID') ?? '1')
}
