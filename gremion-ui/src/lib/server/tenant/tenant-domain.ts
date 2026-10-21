// src/lib/server/tenant/tenant-domain.ts
// Spec B §T.1 — the tenant_domain (control migration 004) accessor half.
//
// TASK-077 G6: TASK-025 extracted this file so "a future kernel API takes this
// file over UNCHANGED"; it now lives, unchanged, in
// packages/tenancy-core/src/tenant-domain.ts. registry.ts and
// registry.domain.integration.test.ts keep importing these names from here.
export {
  __testing,
  addTenantDomain,
  listAllTenantDomains,
  listTenantDomains,
  primaryHostForTenant,
  readPrimaryHost,
  removeTenantDomain,
  setPrimaryDomain,
  TENANT_EVICT_CHANNEL,
} from '@gremion/tenancy-core/tenant-domain'
export type { AddTenantDomainOptions, TenantDomain, TenantDomainWriteDeps } from '@gremion/tenancy-core/tenant-domain'
