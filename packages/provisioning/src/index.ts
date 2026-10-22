// @gremion/provisioning (TASK-043, CAP-PROVISION): create, suspend, resume and
// reconcile a customer through one ledger-driven step machine. ESM, no $lib:
// the Keycloak and control-registry adapters live in gremion-ui's
// provisioner/**, and every resource is reached through a port.
export { assertUuid, ProvisioningError } from './errors.ts'
export type { ProvisioningErrorCode } from './errors.ts'
export { assertCustomerSlug, CUSTOMER_SLUG, MAX_SLUG, MIN_SLUG, principalFor, RESERVED_SLUGS, TENANT_TOKEN, tokenFor } from './slug.ts'
export { EXECUTION_ORDER, isComplete, isStepKind, PHASE_ORDER, PHASES, STEP_ORDER } from './steps.ts'
export type { Phase, StepKind, StepStatus } from './steps.ts'
export { DONE_KEY, doneKinds, isDuplicateDone, latestStatus, memoryLedger, pgLedger } from './ledger.ts'
export type { LedgerPort, StepRow } from './ledger.ts'
export { openLedger, runPhase } from './machine.ts'
export type { RunPhaseOptions, RunPhaseResult, StepFns } from './machine.ts'
export { assertEnableList, DEFAULT_DENY, DENY_REASONS } from './operator-gate.ts'
// TASK-044: the library verbs over the level-1 gate, and the tenant-store
// names TASK-043d's executor codes against (lane note S3 contract).
export { assertDpiaSpec, enableCustomerModule, enableOne, pgGate, preflightGate } from './module-gate.ts'
export type { EnableCustomerModuleResult } from './module-gate.ts'
export {
  assertEnabledModulesProven,
  attestedEnablements,
  EnableRefused,
  IsolationEvidenceError,
  recordDpiaDecision,
  recordIsolationResults,
  regateEnablement,
  unprovenEnablements,
  validateGateForeignKeys,
} from '@gremion/tenant-store/lifecycle'
export type { EnableRefusedCode, UnprovenEnablement } from '@gremion/tenant-store/lifecycle'
export {
  assertAdmins,
  assertEnableLoaded,
  assertHost,
  assertSmtpStamped,
  createPhaseA,
  createPhaseB,
  provisioningStatus,
  recordHostStep,
  resumeCustomer,
  suspendCustomer,
  validateCreate,
} from './customer.ts'
export type { CreateSpec, PhaseOutcome, ProvisioningStatus } from './customer.ts'
export { loadCatalogueRows, OWNING_CONTEXT_CODES, planCatalogueRows, PROVISIONAL_RETENTION_PROFILES, provisionalNote } from './catalogue-rows.ts'
export type { CatalogueModule, CatalogueRowPlan, CatalogueRowsResult } from './catalogue-rows.ts'
export { loadModuleJsons } from './module-tree.ts'
export { bootstrapPlatform, pgModules, type PanelReaderDeps } from './pg.ts'
export {
  ensureExecutorRole,
  ensurePanelRequester,
  EXECUTOR_EXECUTES,
  EXECUTOR_MARKER,
  EXECUTOR_ROLE,
  PANEL_EXECUTES,
  PANEL_READS,
  PANEL_REQUESTER_MARKER,
  type ExecutorRoleDeps,
} from './pg.ts'
export { HANDLED_KINDS, isRequestKind, KIND_OWNER, REQUEST_KINDS, verifyEnableLoaded, verifyRequestArgs } from './requests.ts'
export type { CreateRequestArgs, DpiaDecision, RequestEnvelope, RequestKind, RequestVerdict, VerifyContext } from './requests.ts'
export { renderCustomerRouter } from './router.ts'
export type { CustomerRouterInput } from './router.ts'
export type { BootstrapDeps, BootstrapResult } from './pg.ts'
export type {
  AdminSpec,
  BrokerPort,
  ConfigPort,
  ControlPort,
  ControlRow,
  CustomerRef,
  CustomerStatus,
  DomainPort,
  DpiaSpec,
  FirstBodyPort,
  GatePort,
  KernelDbPort,
  KernelPostCondition,
  MailStampExpectation,
  ModulesPort,
  ProvisioningDeps,
  RealmPort,
  SmtpReadBack,
  StoragePort,
} from './ports.ts'
