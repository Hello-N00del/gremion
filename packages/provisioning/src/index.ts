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
export { assertEnableList, DEFAULT_DENY, INTERIM_GATE_BASIS, operatorAllowGate } from './operator-gate.ts'
export type { AttestationLookup } from './operator-gate.ts'
export {
  assertAdmins,
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
export { loadCatalogueRows, OWNING_CONTEXT_CODES, planCatalogueRows } from './catalogue-rows.ts'
export type { CatalogueModule, CatalogueRowPlan, CatalogueRowsResult } from './catalogue-rows.ts'
export { bootstrapPlatform, pgAttestations, pgModules } from './pg.ts'
export { renderCustomerRouter } from './router.ts'
export type { CustomerRouterInput } from './router.ts'
export type { BootstrapDeps, BootstrapResult } from './pg.ts'
export type {
  AdminSpec,
  AttestationPort,
  BrokerPort,
  ConfigPort,
  ControlPort,
  ControlRow,
  CustomerRef,
  CustomerStatus,
  DomainPort,
  FirstBodyPort,
  KernelDbPort,
  KernelPostCondition,
  ModulesPort,
  ProvisioningDeps,
  RealmPort,
  SmtpReadBack,
  StoragePort,
} from './ports.ts'
