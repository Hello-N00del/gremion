// TASK-015: the `vendor-mail` verify suite (required-suites.txt, grant G4).
//
// SYNCHRONOUS on purpose, like census/suite.mjs: verify.mjs's runAll() calls
// `runner()` without `await`. Two kinds of parts, combined so neither hides
// the other (lib/guard.mjs combineParts):
//   1. every ops/vendor-mail/*.test.mjs, one `node --test` process per file,
//      through suites/unit.mjs#nodeTestParts (declared test() count vs the TAP
//      plan, so a file that stopped registering tests is unparseable);
//   2. each guard's own CLI in verify mode, judged by its exit code AND its
//      summary line (a CLI that printed no summary did not run its check):
//      check-secret-separation (TRD-251), check-principals (fixtures),
//      check-upstream-image (TRD-253), check-deliverability-record (TRD-252;
//      PENDING is a pass until gate F2), and the fixture-drift check.
// docker absent -> toolMissing: the separation guard renders compose.
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { combineParts } from '../../scripts/verify/lib/guard.mjs'
import { run, tail, toolAvailable } from '../../scripts/verify/lib/proc.mjs'
import { nodeTestParts } from '../../scripts/verify/suites/unit.mjs'

export const VENDOR_MAIL_DIR = import.meta.dirname
export const REPO_ROOT = path.join(VENDOR_MAIL_DIR, '..', '..')

export const GUARD_CLIS = [
  { file: 'check-secret-separation.mjs', summary: /^SECRET-SEPARATION: mode=verify static=0 compose=0 app-services=[1-9]\d*$/m },
  { file: 'check-principals.mjs', summary: /^PRINCIPALS: mode=verify allowances=on principals=[1-9]\d* realms=[1-9]\d* violations=0$/m },
  { file: 'check-upstream-image.mjs', summary: /^UPSTREAM-IMAGE: mode=verify digest=sha256:[0-9a-f]{64} violations=0$/m },
  { file: 'check-deliverability-record.mjs', summary: /^DELIVERABILITY: (OK|PENDING) fingerprint=[0-9a-f]{64} records=\d+$/m },
  { file: 'lib/fixture-env.mjs', summary: /^\[fixture-env\] OK: fixtures match the templates$/m },
]

export function vendorMailTestFiles(dir = VENDOR_MAIL_DIR) {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.test.mjs') && !f.split(path.sep).includes('node_modules'))
    .sort()
    // '/'-separated on every OS: one spelling for the TAP labels and the
    // wiring test (path.relative gives backslashes on Windows).
    .map((f) => path.relative(REPO_ROOT, path.join(dir, f)).split(path.sep).join('/'))
}

export function guardParts({ exec = run, clis = GUARD_CLIS } = {}) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.VENDOR_MAIL_MODE
  return clis.map(({ file, summary }) => {
    const label = `ops/vendor-mail/${file}`
    const res = exec(process.execPath, [path.join(VENDOR_MAIL_DIR, file)], { cwd: REPO_ROOT, env })
    const out = `${res.stdout}${res.stderr}`
    if (res.error) return { label, unparseable: true, detail: `could not start: ${res.error.message}` }
    if (res.code === 0 && summary.test(out)) return { label, collected: 1, passed: 1, failed: 0, skipped: 0 }
    if (res.code === 1) return { label, collected: 1, passed: 0, failed: 1, skipped: 0, detail: tail(out) }
    return { label, unparseable: true, detail: `exit ${res.code ?? res.signal} without its summary line -- untrusted\n${tail(out)}` }
  })
}

export function runVendorMailSuite({ docker = toolAvailable('docker'), exec = run } = {}) {
  if (!docker) {
    return { toolMissing: 'docker', unparseable: false, collected: 0, passed: 0, failed: 0, skipped: 0, detail: 'docker is not on PATH -- the TRD-251 compose arm cannot render' }
  }
  const files = vendorMailTestFiles()
  return combineParts([...nodeTestParts({ cwd: REPO_ROOT, files }), ...guardParts({ exec })])
}
