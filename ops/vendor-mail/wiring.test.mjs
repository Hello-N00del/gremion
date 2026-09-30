// TASK-015 TDD item 13: `vendor-mail` is a required verify suite, and it runs.
// Both halves are pinned, because dropping the required-suites.txt line OR the
// SUITE_REGISTRY entry is exactly the shape that silently removes a guard.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { loadRequiredSuites, SUITE_REGISTRY } from '../../scripts/verify/verify.mjs'
import { GUARD_CLIS, guardParts, runVendorMailSuite, vendorMailTestFiles } from './suite.mjs'

test('required-suites.txt names vendor-mail', () => {
  assert.ok(loadRequiredSuites().includes('vendor-mail'), 'required-suites.txt dropped "vendor-mail"')
})

test('SUITE_REGISTRY["vendor-mail"] runs suite-cli.mjs (which runs runVendorMailSuite), synchronously', () => {
  const r = SUITE_REGISTRY['vendor-mail']
  assert.equal(typeof r, 'function', 'SUITE_REGISTRY has no runner for "vendor-mail"')
  // Not called here: this file is itself one of the suite's parts.
  assert.match(String(r), /'ops', 'vendor-mail', 'suite-cli\.mjs'/, 'the registry entry no longer runs ops/vendor-mail/suite-cli.mjs')
  assert.notEqual(r.constructor.name, 'AsyncFunction', 'runAll() does not await its runners')
  assert.notEqual(runVendorMailSuite.constructor.name, 'AsyncFunction', 'runAll() does not await its runners')
  const cli = readFileSync(path.join(import.meta.dirname, 'suite-cli.mjs'), 'utf8')
  assert.match(cli, /^import \{ runVendorMailSuite \} from '\.\/suite\.mjs'$/m)
  assert.match(cli, /VENDOR-MAIL-SUITE \$\{JSON\.stringify\(runVendorMailSuite\(\)\)\}/)
})

test('scripts/verify imports nothing from ops/ (it must load from a copy of itself alone)', () => {
  const verifySrc = readFileSync(path.join(import.meta.dirname, '..', '..', 'scripts', 'verify', 'verify.mjs'), 'utf8')
  assert.doesNotMatch(verifySrc, /^import .* from '\.\.\/\.\.\/ops\//m)
})

test('the suite collects every *.test.mjs of ops/vendor-mail and every guard CLI', () => {
  const files = vendorMailTestFiles()
  for (const f of ['check-secret-separation', 'check-principals', 'check-received', 'check-identities', 'check-upstream-image', 'check-deliverability-record', 'principals', 'wiring']) {
    assert.ok(files.includes(`ops/vendor-mail/${f}.test.mjs`), `the suite no longer collects ${f}.test.mjs`)
  }
  assert.equal(GUARD_CLIS.length, 5)
})

test('a guard CLI that exits 0 without its summary line is unparseable, not a pass', () => {
  const [p] = guardParts({ clis: [GUARD_CLIS[0]], exec: () => ({ code: 0, stdout: '', stderr: '', error: null }) })
  assert.equal(p.unparseable, true)
  const [q] = guardParts({ clis: [GUARD_CLIS[0]], exec: () => ({ code: 1, stdout: 'FAIL x', stderr: '', error: null }) })
  assert.equal(q.failed, 1)
})

test('docker absent is a missing tool, never a skip', () => {
  assert.equal(runVendorMailSuite({ docker: false }).toolMissing, 'docker')
})
