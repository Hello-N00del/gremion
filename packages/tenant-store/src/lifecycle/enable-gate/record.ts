// packages/tenant-store/src/lifecycle/enable-gate/record.ts
//
// TASK-044 (TRD-060 "the result is recorded against the current tip",
// DB-PLT-ISOLATION-TEST-RESULT): imports the isolation evidence file the
// verify run writes (scripts/verify/out/isolation/<sha40>.json, only when the
// `isolation:tenant` part PASSED, lane note S5) into plt.isolation_test_result.
//
// The file is stamped by verify:
//   { produced_by: 'verify', tree_clean: true, release_tip_sha: <sha>,
//     verify_record: { suite: 'isolation:tenant', sha, startedAt, finishedAt,
//                      collected, passed, failed },
//     results: [{ module, test_kind, passed, run_at, release_tip_sha,
//                 evidence_ref: 'sha256:<hex> <location>' }] }
// Refused: an unstamped file (the standalone run.mjs never stamps one), a
// verify record that is not a PASS of isolation:tenant on that sha, no
// results, an unknown module. The stamp is forgeable by hand; signing it as a
// release attestation is TASK-046's (brief Q13, a named residual).
//
// One row per (module, test_kind, release_tip_sha, evidence_ref): a second
// import of the same file inserts nothing. Imports serialize on a SHARE ROW
// EXCLUSIVE lock of the table (self-conflicting; readers, i.e. the gate, are
// not blocked) instead of the brief's pg_advisory_xact_lock: the advisory-lock
// registry (src/advisory-locks.ts) is TASK-079's file in this wave (named
// deviation).
import type { Sql } from '@gremion/db'
import { LifecycleError } from '../guards.js'
import { assertPlatform, lookupModuleId } from '../platform.js'
import { RELEASE_TIP } from './gate.js'

export type IsolationEvidenceErrorCode = 'EVIDENCE_MALFORMED' | 'EVIDENCE_UNSTAMPED' | 'EVIDENCE_NOT_PASS' | 'EVIDENCE_EMPTY' | 'MODULE_UNKNOWN'

export class IsolationEvidenceError extends Error {
  override name = 'IsolationEvidenceError'
  constructor(
    readonly code: IsolationEvidenceErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
  }
}

/** The verify part whose PASS the evidence must carry. */
export const ISOLATION_TENANT_PART = 'isolation:tenant'

/** 'sha256:<64 hex> <location>' (brief S1 Record). */
export const EVIDENCE_REF = /^sha256:[0-9a-f]{64} \S.{0,420}$/

export interface IsolationResultEntry {
  module: string
  test_kind: 'cross_customer' | 'cross_body'
  passed: boolean
  run_at: string
  release_tip_sha: string
  evidence_ref: string
}

export interface IsolationEvidence {
  produced_by: 'verify'
  tree_clean: true
  release_tip_sha: string
  verify_record: { suite: string; sha: string; startedAt: string; finishedAt: string; collected: number; passed: number; failed: number }
  results: IsolationResultEntry[]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isIso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v))
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

/** Validates the parsed JSON of an evidence file; touches no database. */
export function parseIsolationEvidence(json: unknown): IsolationEvidence {
  const fail = (code: IsolationEvidenceErrorCode, m: string): never => {
    throw new IsolationEvidenceError(code, m)
  }
  if (!isObj(json)) return fail('EVIDENCE_MALFORMED', 'the evidence is not a JSON object')
  if (json.produced_by !== 'verify' || json.tree_clean !== true || !isObj(json.verify_record)) {
    return fail('EVIDENCE_UNSTAMPED', `the file is not stamped by verify (produced_by=${JSON.stringify(json.produced_by)}, tree_clean=${JSON.stringify(json.tree_clean)}, verify_record ${isObj(json.verify_record) ? 'present' : 'absent'}); a standalone run.mjs result is never imported`)
  }
  const tip = json.release_tip_sha
  if (typeof tip !== 'string' || !RELEASE_TIP.test(tip)) return fail('EVIDENCE_MALFORMED', `release_tip_sha ${JSON.stringify(tip)} is not a full lowercase commit id`)
  const vr = json.verify_record
  if (vr.suite !== ISOLATION_TENANT_PART) return fail('EVIDENCE_NOT_PASS', `the verify record is for ${JSON.stringify(vr.suite)}, not ${ISOLATION_TENANT_PART}`)
  if (vr.sha !== tip) return fail('EVIDENCE_NOT_PASS', `the verify record ran on ${JSON.stringify(vr.sha)}, not the evidence's tip ${tip}`)
  if (!isIso(vr.startedAt) || !isIso(vr.finishedAt)) return fail('EVIDENCE_MALFORMED', 'the verify record has no ISO startedAt/finishedAt')
  if (!isCount(vr.collected) || !isCount(vr.passed) || !isCount(vr.failed)) return fail('EVIDENCE_MALFORMED', 'the verify record counts are not non-negative integers')
  if (vr.collected === 0 || vr.failed !== 0 || vr.passed !== vr.collected) {
    return fail('EVIDENCE_NOT_PASS', `the verify record is not a PASS (collected ${vr.collected}, passed ${vr.passed}, failed ${vr.failed}): zero collected or any failure is no pass`)
  }
  if (!Array.isArray(json.results) || json.results.length === 0) return fail('EVIDENCE_EMPTY', 'the evidence names no module result')
  const results: IsolationResultEntry[] = []
  for (const [i, r] of json.results.entries()) {
    const at = `results[${i}]`
    if (!isObj(r)) return fail('EVIDENCE_MALFORMED', `${at} is not an object`)
    if (typeof r.module !== 'string' || !/^[a-z][a-z_]{1,39}$/.test(r.module)) return fail('EVIDENCE_MALFORMED', `${at}.module ${JSON.stringify(r.module)} is not a module key`)
    if (r.test_kind !== 'cross_customer' && r.test_kind !== 'cross_body') return fail('EVIDENCE_MALFORMED', `${at}.test_kind ${JSON.stringify(r.test_kind)}`)
    if (r.passed !== true) return fail('EVIDENCE_NOT_PASS', `${at} (${r.module}) did not pass, yet the verify record says PASS: inconsistent evidence`)
    if (!isIso(r.run_at)) return fail('EVIDENCE_MALFORMED', `${at}.run_at is not an ISO timestamp`)
    if (r.release_tip_sha !== tip) return fail('EVIDENCE_MALFORMED', `${at}.release_tip_sha ${JSON.stringify(r.release_tip_sha)} is not the evidence's tip ${tip}`)
    if (typeof r.evidence_ref !== 'string' || !EVIDENCE_REF.test(r.evidence_ref)) return fail('EVIDENCE_MALFORMED', `${at}.evidence_ref is not 'sha256:<64 hex> <location>'`)
    results.push({ module: r.module, test_kind: r.test_kind, passed: true, run_at: r.run_at, release_tip_sha: tip, evidence_ref: r.evidence_ref })
  }
  return {
    produced_by: 'verify',
    tree_clean: true,
    release_tip_sha: tip,
    verify_record: { suite: vr.suite, sha: tip, startedAt: vr.startedAt, finishedAt: vr.finishedAt, collected: vr.collected, passed: vr.passed, failed: vr.failed },
    results,
  }
}

export interface RecordIsolationResult {
  /** Ids of the rows this import wrote. */
  inserted: { module: string; testKind: string; isolationTestResultId: string }[]
  /** Ids of the rows that were already there (same module, kind, tip and evidence). */
  existing: { module: string; testKind: string; isolationTestResultId: string }[]
}

/**
 * Imports a verify-stamped evidence file (its parsed JSON) in ONE transaction:
 * every module known or nothing is written.
 */
export async function recordIsolationResults(platform: Sql, json: unknown): Promise<RecordIsolationResult> {
  const ev = parseIsolationEvidence(json)
  await assertPlatform(platform)
  const moduleIds = new Map<string, string>()
  for (const r of ev.results) {
    if (moduleIds.has(r.module)) continue
    const id = await lookupModuleId(platform, r.module)
    if (!id) throw new IsolationEvidenceError('MODULE_UNKNOWN', `plt.module has no module ${r.module}: nothing was recorded`)
    moduleIds.set(r.module, id)
  }
  const out: RecordIsolationResult = { inserted: [], existing: [] }
  await platform.begin(async (tx) => {
    await tx`LOCK TABLE plt.isolation_test_result IN SHARE ROW EXCLUSIVE MODE`
    for (const r of ev.results) {
      const moduleId = moduleIds.get(r.module)!
      const [have] = await tx<{ id: string }[]>`
        SELECT isolation_test_result_id::text AS id FROM plt.isolation_test_result
         WHERE module_id = ${moduleId} AND test_kind = ${r.test_kind} AND release_tip_sha = ${r.release_tip_sha} AND evidence_ref = ${r.evidence_ref}
         ORDER BY created_at LIMIT 1`
      if (have) {
        out.existing.push({ module: r.module, testKind: r.test_kind, isolationTestResultId: have.id })
        continue
      }
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO plt.isolation_test_result (module_id, test_kind, passed, run_at, evidence_ref, release_tip_sha)
        VALUES (${moduleId}, ${r.test_kind}, ${r.passed}, ${r.run_at}, ${r.evidence_ref}, ${r.release_tip_sha})
        RETURNING isolation_test_result_id::text AS id`
      if (!row) throw new LifecycleError('CONCURRENT_STATE', `the isolation result insert for ${r.module} returned no row`)
      out.inserted.push({ module: r.module, testKind: r.test_kind, isolationTestResultId: row.id })
    }
  })
  return out
}
