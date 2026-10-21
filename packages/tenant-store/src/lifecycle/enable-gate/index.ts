// @gremion/tenant-store/lifecycle -> enable-gate (TASK-044, CAP-ISOLATION):
// the level-1 gate enableModule takes as deps.enableGate, the records it reads
// (isolation evidence, DPIA decisions) and the checks over what is already
// enabled. This directory (and test code) is the only place an EnableGate is
// implemented (source-scan.test.ts).
export {
  acceptedDpiaDecision,
  assertIsolationProven,
  assertReleaseTip,
  createEnableGate,
  ENABLE_REFUSED_CODES,
  EnableRefused,
  FIXTURE_EVIDENCE_PREFIX,
  latestDpiaDecision,
  provenIsolationResult,
  RELEASE_TIP,
} from './gate.js'
export type { DpiaDecisionRow, EnableGateOptions, EnableRefusedCode } from './gate.js'
export { assertDpiaDecisionInput, REASON_CODE, recordDpiaDecision, REQUIRES_DPIA } from './dpia.js'
export type { DpiaDecisionInput, RequiresDpia } from './dpia.js'
export { EVIDENCE_REF, ISOLATION_TENANT_PART, IsolationEvidenceError, parseIsolationEvidence, recordIsolationResults } from './record.js'
export type { IsolationEvidence, IsolationEvidenceErrorCode, IsolationResultEntry, RecordIsolationResult } from './record.js'
export {
  assertEnabledModulesProven,
  attestedEnablements,
  ENABLEMENT_GATE_KEYS,
  EnablementsUnproven,
  regateEnablement,
  unprovenEnablements,
  validateGateForeignKeys,
} from './regate.js'
export type { AttestedEnablement, RegateResult, UnprovenEnablement, ValidateKeysResult } from './regate.js'
