// TASK-045 round 2: suites/unit.mjs sub-checks against real subprocesses.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { combineParts, evaluateSuite } from './lib/guard.mjs'
import { batsWindowsTags, judgeBats, nodeTestParts, vitestSubcheck } from './suites/unit.mjs'

const WIRING = path.join(import.meta.dirname, '__fixtures__', 'vitest-script-wiring')
const FIXTURES = path.join(import.meta.dirname, '__fixtures__')

test('vitestSubcheck does not trust an all-green report when the test command itself exited non-zero', () => {
  const r = vitestSubcheck({ cwd: WIRING, testScript: 'test:green-exit1' })
  assert.equal(r.unparseable, true, JSON.stringify(r))
  assert.match(r.detail, /exited 1/)
})

test('vitestSubcheck attributes skips to repo-relative files so the per-file allow-list can match them', () => {
  const root = path.join(import.meta.dirname, '..', '..')
  const r = vitestSubcheck({ cwd: WIRING, testScript: 'test:skips', root })
  assert.equal(r.unparseable, false, JSON.stringify(r))
  assert.deepEqual(r.skipsByFile, { 'scripts/verify/__fixtures__/vitest-script-wiring/skipped.fixture.test.ts': 1 })
})

test('nodeTestParts reports a file with zero declared tests as an EMPTY part, which fails the suite by name', () => {
  const parts = nodeTestParts({ cwd: FIXTURES, files: ['node-zero/zero.test.mjs'] })
  const verdict = evaluateSuite(combineParts(parts))
  assert.equal(verdict.status, 'fail')
  assert.match(verdict.reason, /collected 0 tests in: node --test node-zero\/zero\.test\.mjs/)
})

// A skip in a node --test file used to come back unattributed, so lib/skips.mjs
// booked it under a key no allowed-skips.json entry can match: listing a file
// there could never take effect for unit:node. One process runs per file, so the
// skips are that file's own.
test('nodeTestParts attributes the skips of a file to that file, so the per-file allow-list can match them', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'node-skip-'))
  try {
    writeFileSync(
      path.join(dir, 'one-skip.test.mjs'),
      ["import test from 'node:test'", "test('runs', () => {})", "test('does not run here', { skip: 'fixture' }, () => {})", ''].join(String.fromCharCode(10)),
    )
    const parts = nodeTestParts({ cwd: dir, files: ['one-skip.test.mjs'] })
    assert.equal(parts.length, 1)
    assert.deepEqual(
      { collected: parts[0].collected, skipped: parts[0].skipped, skipsByFile: parts[0].skipsByFile },
      { collected: 2, skipped: 1, skipsByFile: { 'one-skip.test.mjs': 1 } },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('nodeTestParts with no files at all is one empty part, never nothing', () => {
  const parts = nodeTestParts({ cwd: FIXTURES, files: [] })
  assert.equal(evaluateSuite(combineParts(parts)).status, 'fail')
})

// Round 2 LOW: batsPartWindows used to build fixed ":local" tags a second
// worktree, or a second concurrent verify run, could clobber mid-build.
const REPO_ROOT = path.join(import.meta.dirname, '..', '..')

test('batsWindowsTags is unique per run (pid), never the old shared ":local" tag', () => {
  const a = batsWindowsTags(REPO_ROOT, 11111)
  const b = batsWindowsTags(REPO_ROOT, 22222)
  assert.notEqual(a.runnerTag, b.runnerTag)
  assert.notEqual(a.pyTag, b.pyTag)
  assert.doesNotMatch(a.runnerTag, /^gremion-bats:local$/)
  assert.doesNotMatch(a.pyTag, /^gremion-bats-py:local$/)
  assert.match(a.runnerTag, /^gremion-bats:verify-[0-9a-f]{8}-11111$/)
  assert.match(a.pyTag, /^gremion-bats-py:verify-[0-9a-f]{8}-11111$/)
})

// CI run 4: unit:bats FAILED "1 of 1668", but the detail was the last 1500 characters of the TAP -- the
// tail of 1668 `ok` lines and a bats warning -- so the failing test was named nowhere in the log. A
// failure's detail now leads with every `not ok` line and the diagnostic lines under it.
const NL = String.fromCharCode(10)
const DIAG = ['# (in test file test/host/x.bats, line 7)', "#   `[ \"$status\" -eq 0 ]' failed", '# some diagnostic output']
function batsTap({ fails, total = 120 }) {
  const lines = [`1..${total}`]
  for (let i = 1; i <= total; i++) {
    if (fails[i]) lines.push(`not ok ${i} ${fails[i].name}`, ...fails[i].diag)
    else lines.push(`ok ${i} a passing test with a reasonably long descriptive name to push the tail along`)
  }
  lines.push('', 'The following warnings were encountered during tests:', 'BW02: Using flags on `run` requires at least BATS_VERSION=1.5.0.')
  return lines.join(NL) + NL
}

test('judgeBats names the failing test and its diagnostics even when the tail is all passing tests', () => {
  const tap = batsTap({ fails: { 5: { name: 'the guard that went red', diag: DIAG } } })
  const r = judgeBats('bats x', { code: 1, stdout: tap, stderr: '' }, 'bats')
  assert.equal(r.failed, 1)
  assert.ok(r.detail.includes('not ok 5 the guard that went red'), r.detail)
  assert.match(r.detail, /# \(in test file test\/host\/x\.bats, line 7\)/)
  assert.match(r.detail, /# some diagnostic output/)
  // ahead of the tail, and the tail is still there
  assert.ok(r.detail.indexOf('not ok 5') < r.detail.indexOf('ok 120 '), r.detail)
  assert.match(r.detail, /BW02/)
})

test('judgeBats lists every failing test, each with only its own diagnostics', () => {
  const tap = batsTap({ total: 10, fails: { 3: { name: 'the guard that went red', diag: DIAG }, 8: { name: 'the second red one', diag: ['# its own diagnostic'] } } })
  const r = judgeBats('bats x', { code: 1, stdout: tap, stderr: '' }, 'bats')
  const head = r.detail.split('--- tail')[0]
  assert.match(head, /not ok 3 the guard that went red/)
  assert.match(head, /not ok 8 the second red one\n# its own diagnostic/)
  assert.doesNotMatch(head, /^ok /m)
})

test('judgeBats caps a runaway diagnostic so one noisy failure cannot bury the others', () => {
  const noisy = Array.from({ length: 500 }, (_, i) => `# noise line ${i}`)
  const r = judgeBats('bats x', { code: 1, stdout: batsTap({ total: 120, fails: { 2: { name: 'the guard that went red', diag: noisy } } }), stderr: '' }, 'bats')
  assert.match(r.detail, /not ok 2 the guard that went red/)
  assert.match(r.detail, /noise line 0\b/)
  assert.doesNotMatch(r.detail, /noise line 499\b/)
  assert.ok(r.detail.length < 20_000, `detail is ${r.detail.length} characters`)
})

test('judgeBats leaves a clean run without a detail', () => {
  const r = judgeBats('bats x', { code: 0, stdout: batsTap({ total: 5, fails: {} }), stderr: '' }, 'bats')
  assert.equal(r.failed, 0)
  assert.equal(r.detail, '')
})

test('nodeTestParts names a failing test too, though a long run of passing ones follows it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'node-fail-'))
  try {
    const passing = Array.from({ length: 40 }, (_, i) => `test('a passing test with a long name to fill the tail ${i}', () => {})`)
    writeFileSync(
      path.join(dir, 'red.test.mjs'),
      ["import test from 'node:test'", "import assert from 'node:assert/strict'", "test('the guard that went red', () => { assert.equal('left-hand-value', 'right-hand-value') })", ...passing, ''].join(NL),
    )
    const parts = nodeTestParts({ cwd: dir, files: ['red.test.mjs'] })
    assert.equal(parts[0].failed, 1)
    assert.match(parts[0].detail, /not ok \d+ - the guard that went red/)
    assert.match(parts[0].detail, /left-hand-value/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
