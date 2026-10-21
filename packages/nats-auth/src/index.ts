// @gremion/nats-auth — admit NATS clients only by per-module nkey inside one
// account per tenant (TASK-024, CAP-NATS-AUTH; D12, TRD-419, PRD-PLAT-012).
export { FLOWS, NO_BROKER, NO_STREAM, OWNER_TO_MODULE, KERNEL, SYSTEM_STREAMS, dlqGrantFor, matrixViolations, loadRegistryAddresses } from './flows.ts'
export type { ModuleFlow, MatrixInput, NoStreamEntry, RegistryAddress } from './flows.ts'
export {
  modulePermissions,
  adminPermissions,
  SYS_RELOAD_PERMISSIONS,
  permissionViolations,
  sysReloadViolations,
  inboxPrefixFor,
  accountFor,
  tenantSubjects,
} from './permissions.ts'
export type { Permissions, PermissionSet } from './permissions.ts'
export { renderServerConfig } from './render.ts'
export type { ServerState, TenantState } from './render.ts'
export { ensureTenantAccount, initAccounts, stateFromStore, usersFor, streamsFor } from './ensure.ts'
export type { BrokerOps, EnsureOptions, EnsureResult } from './ensure.ts'
export { natsConnectOptionsFor, adminConnectOptionsFor, DEFAULT_SECRETS_DIR, DEFAULT_ACCOUNTS_DIR } from './connect.ts'
export { natsBrokerOps } from './broker-ops.ts'
export { SeedStore } from './store.ts'
