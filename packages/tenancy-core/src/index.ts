// @gremion/tenancy-core — the kernel-portable tenancy primitives (TASK-077 G6,
// TRD-074/TRD-076): the ONE host normaliser, the platform-reserved host list,
// the tenant_domain accessors and the bounded host-rejection log. Shared by
// gremion-ui (whose four tenant/ files re-export these) and the kernel API.
// No SvelteKit, no env, no I/O of its own: every DB handle and log sink is
// passed in (gremion-ui's kernel-portable.guard.test.ts scans this tree).
export { hostFromIssuer, normaliseHost } from './host.ts'
export { isReservedPlatformHost, RESERVED_PLATFORM_LABELS, reservedPlatformHosts } from './reserved-hosts.ts'
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
} from './tenant-domain.ts'
export type { AddTenantDomainOptions, TenantDomain, TenantDomainWriteDeps } from './tenant-domain.ts'
export {
  createHostRejectionLog,
  DEDUPE_WINDOW_MS,
  HOST_REJECTED_EVENT,
  HOST_REJECTED_FLOOD_EVENT,
  MAX_DEDUPE_KEYS,
  MAX_LINES_PER_WINDOW,
  MAX_LOGGED_HOST_CHARS,
} from './host-mismatch-log.ts'
export type { HostRejectionLog, HostRejectionLogDeps, HostRejectReason, LogFieldValue } from './host-mismatch-log.ts'
