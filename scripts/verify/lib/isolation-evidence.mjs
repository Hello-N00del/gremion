// Pilot wave 2, Task 1: the isolation evidence file.
//
//   scripts/verify/out/isolation/<sha40>.json            the stamped file
//   scripts/verify/out/isolation/<sha40>/<module>.vitest.json   the reports it hashes
//
// It is what `gremion-isolation record` imports into plt.isolation_test_result
// through the container verb `isolation-record`
// (packages/tenant-store/src/lifecycle/enable-gate/record.ts, parseIsolationEvidence).
// The shape is that parser's contract:
//   { produced_by: 'verify', tree_clean: true, release_tip_sha,
//     verify_record: { suite: 'isolation:tenant', sha, startedAt, finishedAt, collected, passed, failed },
//     results: [{ module, test_kind: 'cross_customer', passed: true, run_at, release_tip_sha,
//                 evidence_ref: 'sha256:<64 hex> <location>' }] }
//
// WHO MAY CALL THIS: verify.mjs only, after its own dirty-tree and HEAD-moved
// checks, for a run whose names are exactly `isolation:tenant`. The writer
// re-checks everything it can on its own, because an evidence file is the one
// artifact the enable gate trusts and a wrong file is worse than none:
//   - exactly that one suite name, a PASS verdict, a full lowercase commit id;
//   - the modules in the evidence are exactly the declared ones, all inside the
//     pilot set (never board, elections, finance, vault or handover);
//   - every module: tests collected, all of them passed, none failed, none
//     skipped (parseIsolationEvidence refuses passed != collected), its test
//     files pinned, its kept vitest report present and hashing to the reference;
//   - the suite totals are the same clean shape.
// Nothing is written unless all of it holds; the stamped file is written last,
// atomically, so a reader never sees a half-written one.
//
// The stamp is forgeable by hand until TASK-046 signs it (record.ts:19-20): this
// file narrows how a wrong one is produced, it is not an attestation.
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ISOLATION_TENANT_MODULES, ISOLATION_TENANT_PART } from '../suites/isolation-tenant.mjs'
import { OUT_DIR } from './record.mjs'

export const ISOLATION_OUT_DIR = path.join(OUT_DIR, 'isolation')

const TIP = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const HEX64 = /^[0-9a-f]{64}$/
const EVIDENCE_REF = /^sha256:[0-9a-f]{64} \S.{0,420}$/

export class IsolationEvidenceRefused extends Error {
  constructor(message) {
    super(`isolation evidence refused: ${message}`)
    this.name = 'IsolationEvidenceRefused'
  }
}

const refuse = (message) => {
  throw new IsolationEvidenceRefused(message)
}

export function isolationEvidencePath(sha, outDir = ISOLATION_OUT_DIR) {
  return path.join(outDir, `${sha}.json`)
}

function sha256OfFile(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

/**
 * Validates and builds the evidence object. Touches no file except reading the
 * kept reports. Throws IsolationEvidenceRefused.
 */
export function buildIsolationEvidence({ sha, names, result, startedAt, finishedAt }) {
  if (!Array.isArray(names) || names.length !== 1 || names[0] !== ISOLATION_TENANT_PART) {
    refuse(`only a run of exactly ${ISOLATION_TENANT_PART} may produce it (got ${JSON.stringify(names)})`)
  }
  if (typeof sha !== 'string' || !TIP.test(sha)) refuse(`sha ${JSON.stringify(sha)} is not a full lowercase commit id`)
  if (result?.status !== 'pass') refuse(`the suite verdict is ${JSON.stringify(result?.status)}, not pass`)
  const ev = result.evidence
  if (!ev || !Array.isArray(ev.modules) || !Array.isArray(ev.declaredModules)) refuse('the suite result carries no per-module evidence')
  if (![startedAt, finishedAt].every((t) => typeof t === 'string' && Number.isFinite(Date.parse(t)))) refuse('startedAt/finishedAt are not ISO timestamps')

  for (const m of ev.declaredModules) {
    if (!ISOLATION_TENANT_MODULES.includes(m)) refuse(`module ${JSON.stringify(m)} is outside the pilot set (${ISOLATION_TENANT_MODULES.join(', ')})`)
  }
  const have = ev.modules.map((m) => m.module)
  const dup = have.find((m, i) => have.indexOf(m) !== i)
  if (dup) refuse(`module ${dup} appears twice`)
  const missing = ev.declaredModules.filter((m) => !have.includes(m))
  const extra = have.filter((m) => !ev.declaredModules.includes(m))
  if (missing.length > 0 || extra.length > 0) {
    refuse(`the modules are not exactly the declared ones (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`)
  }

  const results = []
  for (const m of ev.modules) {
    const at = `module ${m.module}`
    if (!(m.collected > 0)) refuse(`${at} collected no test`)
    if (m.failed !== 0) refuse(`${at} has ${m.failed} failed test(s)`)
    if (m.skipped !== 0) refuse(`${at} has ${m.skipped} skipped test(s): a skipped case is no proof`)
    if (m.passed !== m.collected) refuse(`${at} passed ${m.passed} of ${m.collected}`)
    if (m.pinned !== true) refuse(`${at} did not collect its test files`)
    if (typeof m.reportSha256 !== 'string' || !HEX64.test(m.reportSha256)) refuse(`${at} has no report hash`)
    const now = sha256OfFile(m.reportPath)
    if (now !== m.reportSha256) refuse(`${at}: the kept vitest report is missing or its hash no longer matches the reference`)
    const evidence_ref = `sha256:${m.reportSha256} ${m.location}`
    if (!EVIDENCE_REF.test(evidence_ref)) refuse(`${at}: evidence_ref ${JSON.stringify(evidence_ref)} is not 'sha256:<64 hex> <location>'`)
    if (evidence_ref.startsWith('scratch-fixture:') || /scratch-fixture:/.test(m.location)) refuse(`${at}: a scratch-fixture reference is never produced here`)
    if (typeof m.runAt !== 'string' || !Number.isFinite(Date.parse(m.runAt))) refuse(`${at} has no run_at`)
    results.push({ module: m.module, test_kind: 'cross_customer', passed: true, run_at: m.runAt, release_tip_sha: sha, evidence_ref })
  }

  const { collected, passed, failed, skipped } = result
  if (!(collected > 0) || failed !== 0 || skipped !== 0 || passed !== collected) {
    refuse(`the suite totals are not a clean pass (collected ${collected}, passed ${passed}, failed ${failed}, skipped ${skipped})`)
  }
  return {
    produced_by: 'verify',
    tree_clean: true,
    release_tip_sha: sha,
    verify_record: { suite: ISOLATION_TENANT_PART, sha, startedAt, finishedAt, collected, passed, failed },
    results,
  }
}

/**
 * Writes the kept reports and then the stamped file. Returns `{ path, evidence }`.
 * Throws IsolationEvidenceRefused before touching `outDir` when anything is off.
 */
export function writeIsolationEvidence({ sha, names, result, startedAt, finishedAt, outDir = ISOLATION_OUT_DIR }) {
  const evidence = buildIsolationEvidence({ sha, names, result, startedAt, finishedAt })
  const reportsDir = path.join(outDir, sha)
  rmSync(reportsDir, { recursive: true, force: true })
  mkdirSync(reportsDir, { recursive: true })
  for (const m of result.evidence.modules) copyFileSync(m.reportPath, path.join(reportsDir, `${m.module}.vitest.json`))
  const dest = isolationEvidencePath(sha, outDir)
  const tmp = `${dest}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  renameSync(tmp, dest)
  return { path: dest, evidence }
}
