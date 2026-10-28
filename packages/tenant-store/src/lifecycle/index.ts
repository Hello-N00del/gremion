// @gremion/tenant-store/lifecycle — create or drop the database of one
// (tenant, module) (D13, TRD-424), and the TRD-089 inspection. A subpath of
// its own: the package root exports no create/drop helper (index.test.ts).
export { disableModule, dropTenantModuleDatabase } from './disable.js'
export { enableModule, ensureModuleRoles, lockDownDatabase } from './enable.js'
// TASK-044: the level-1 enable gate, its records and the enabled-module checks (CAP-ISOLATION).
export * from './enable-gate/index.js'
export { exportDatabase, exportStamp, pgDumpExporter } from './export.js'
export type { PgDumpExporterOptions, VerifiedExport } from './export.js'
export {
  assertTenantModuleTarget,
  LifecycleError,
  moduleRoles,
  NEVER_OPENED,
  RESERVED_MODULE_IDS,
  TENANT_MODULE_DB,
} from './guards.js'
export type { LifecycleErrorCode } from './guards.js'
export { inspectTenantDatabases } from './inspect.js'
export type { InspectionReport, InspectRegistry, InspectServer, ServerReport } from './inspect.js'
// TASK-043 G1: the customer's kernel database (never migrated here, Q3) and the platform bootstrap (Q15).
export { dropKernelDatabase, ensureKernelDatabase, ensureKernelRoles, KERNEL_MODULE, kernelDbName, kernelRoles } from './kernel.js'
export type { EnsureKernelResult, KernelRoles } from './kernel.js'
// TASK-077 (C13): the kernel API's SELECT-only role on control + gremion_platform.
export { ensureKernelApiReader, KERNEL_API_READS, KernelApiReaderError, kernelApiReaderPrivilegeProblems } from './kernel-api-reader.js'
export type { KernelApiReaderDeps, KernelApiReaderErrorCode } from './kernel-api-reader.js'
export {
  assertPlatform,
  ensurePlatformDatabase,
  lookupModuleVersion,
  migratePlatform,
  PLATFORM_DATABASE,
  PLATFORM_MIGRATIONS_DIR,
} from './platform.js'
export type { EnsurePlatformResult } from './platform.js'
// TRD-144/145: the scheduled purge run and the rule table it executes (retention-catalogue.md).
export { deleteBatchSql, PURGE_RESIDUAL, PURGE_RULES, purgeCutoff, runPurge } from './purge.js'
export type { PurgeDeps, PurgeError, PurgeResult, PurgeRule, PurgeSkip } from './purge.js'
export { scramSha256Verifier } from './scram.js'
export type {
  Actor,
  DisableResult,
  EnableGate,
  EnableResult,
  Exporter,
  ExportTarget,
  GateResult,
  LifecycleDeps,
  LifecycleModule,
  LifecycleStep,
  ModuleServer,
} from './types.js'
