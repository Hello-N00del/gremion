// @gremion/module-catalogue — the one module.json validator (spec D D.1.2)
// and the ops facts derived from the catalogue (TASK-021, PRD-PLAT-012).
export { checkCatalogue, KERNEL_ROOT, loadCatalogue } from './catalogue.ts'
export type { Catalogue, CheckOptions, CheckResult } from './catalogue.ts'
export { runCli, USAGE } from './cli.ts'
export type { CliIo } from './cli.ts'
export { composeDefault, parseCompose, readCompose } from './compose.ts'
export {
  buildCatalogueOps,
  deriveBackupServices,
  deriveColourGatedJobs,
  KERNEL_PLATFORM_DATABASES,
  KERNEL_POSTGRES_SERVICE,
  platformDatabases,
  POSTGRES_LABEL,
  SERVER_BUILTIN_DATABASES,
  serverDefaultDatabase,
} from './runtime.ts'
export type {
  CatalogueEntry,
  CatalogueOps,
  ComposeModel,
  ComposeService,
  DatabaseDecl,
  ExportDecl,
  ModuleJson,
  ModuleRuntime,
  PlatformServerDecl,
  TimedJob,
} from './runtime.ts'
export {
  checkClaims,
  MAX_MODULE_ID_BYTES,
  NAMES_MODULE_ID,
  PLATFORM_DATABASE_NAME,
  RETENTION_PROFILE,
  SCHEMA_MODULE_KEY,
  SEMVER,
  validateModuleJson,
} from './validate.ts'
export type { ContractsRegistry, ValidateContext } from './validate.ts'
