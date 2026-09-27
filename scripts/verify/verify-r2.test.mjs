// TASK-045 round 2: verify.mjs's entrypoint and runAll, driven through
// injected dependencies (runVerify) so the tree/HEAD/record paths can be
// exercised without a real dirty tree or a real suite run.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { test } from 'node:test'
import { parseArgs, runAll, runVerify } from './verify.mjs'

const VERIFY = path.join(import.meta.dirname, 'verify.mjs')
const SKIPS = {
  entries: [{ suite: 'fake', file: 'allowed/one.test.ts', reason: 'r', maxCount: 5 }],
}

function greenRaw() {
  return { toolMissing: null, unparseable: false, collected: 3, passed: 3, failed: 0, skipped: 0 }
}

function harness(overrides = {}) {
  const calls = { runAll: 0, writeRecord: [], out: [], err: [] }
  const deps = {
    isDirtyFn: () => false,
    headShaFn: () => 'a'.repeat(40),
    loadRequiredFn: () => ['typecheck'],
    loadSkipsFn: () => SKIPS,
    runAllFn: (names) => {
      calls.runAll++
      return Object.fromEntries(names.map((n) => [n, { status: 'pass', reason: null, collected: 1, passed: 1, failed: 0, skipped: 0, detail: '', durationMs: 1 }]))
    },
    writeRecordFn: (rec) => {
      calls.writeRecord.push(rec)
      return { path: 'out/x.json' }
    },
    log: (m) => calls.out.push(m),
    error: (m) => calls.err.push(m),
    ...overrides,
  }
  return { deps, calls }
}

test('parseArgs rejects an unknown argument instead of silently running everything (no skip flag exists)', () => {
  assert.throws(() => parseArgs(['--skip', 'unit']), /unknown argument: --skip/)
  assert.throws(() => parseArgs(['--onyl=unit']), /unknown argument/)
})

test('parseArgs rejects --only with no suite name', () => {
  assert.throws(() => parseArgs(['--only']), /--only needs/)
  assert.throws(() => parseArgs(['--only=']), /--only needs/)
  assert.throws(() => parseArgs(['--only', '--only', 'unit']), /--only needs/)
})

test('the CLI turns a usage error into a formatted [verify] failure and exit 1, not a stack trace', () => {
  const res = spawnSync(process.execPath, [VERIFY, '--only'], { encoding: 'utf8' })
  assert.equal(res.status, 1, res.stdout + res.stderr)
  assert.match(res.stderr, /\[verify\] usage error: --only needs/)
  assert.doesNotMatch(res.stderr, /TypeError/)
})

test('runVerify refuses a dirty tree before running any real suite', () => {
  const { deps, calls } = harness({ isDirtyFn: () => true })
  assert.equal(runVerify([], deps), 1)
  assert.equal(calls.runAll, 0)
  assert.equal(calls.writeRecord.length, 0)
})

test('runVerify fails, and writes no record, when the tree became dirty DURING the run', () => {
  let n = 0
  const { deps, calls } = harness({ isDirtyFn: () => n++ > 0 })
  assert.equal(runVerify([], deps), 1)
  assert.equal(calls.writeRecord.length, 0)
  assert.match(calls.err.join('\n'), /changed during the run/)
})

test('runVerify fails, and writes no record, when HEAD moved during the run', () => {
  let n = 0
  const { deps, calls } = harness({ headShaFn: () => (n++ === 0 ? 'a'.repeat(40) : 'b'.repeat(40)) })
  assert.equal(runVerify([], deps), 1)
  assert.equal(calls.writeRecord.length, 0)
  assert.match(calls.err.join('\n'), /HEAD moved/)
})

test('runVerify keys the record to the sha taken BEFORE the run', () => {
  const { deps, calls } = harness()
  assert.equal(runVerify([], deps), 0)
  assert.equal(calls.writeRecord[0].sha, 'a'.repeat(40))
})

test('runVerify refuses to run when allowed-skips.json cannot be loaded, instead of judging with an empty list', () => {
  const { deps, calls } = harness({
    loadSkipsFn: () => {
      throw new Error('boom: bad json')
    },
  })
  assert.equal(runVerify([], deps), 1)
  assert.equal(calls.runAll, 0)
  assert.match(calls.err.join('\n'), /allowed-skips\.json.*boom: bad json/)
})

test('runAll enforces the allow-list per FILE: a skip in an unlisted file fails even inside the suite-wide budget', () => {
  const registry = { fake: () => ({ ...greenRaw(), collected: 10, passed: 9, skipped: 1, skipsByFile: { 'other/file.test.ts': 1 } }) }
  const r = runAll(['fake'], { skipsData: SKIPS, registry }).fake
  assert.equal(r.status, 'fail')
  assert.match(r.reason, /unaccounted skip\(s\): other\/file\.test\.ts/)
})

test('runAll books a skip a suite cannot attribute to a file under a zero budget', () => {
  const registry = { fake: () => ({ ...greenRaw(), collected: 10, passed: 9, skipped: 1 }) }
  const r = runAll(['fake'], { skipsData: SKIPS, registry }).fake
  assert.equal(r.status, 'fail')
  assert.match(r.reason, /not attributable to a file/)
})

test('runAll passes a skip inside its own file\'s budget', () => {
  const registry = { fake: () => ({ ...greenRaw(), collected: 10, passed: 9, skipped: 1, skipsByFile: { 'allowed/one.test.ts': 1 } }) }
  assert.equal(runAll(['fake'], { skipsData: SKIPS, registry }).fake.status, 'pass')
})

test('runAll without allow-list data fails a suite that skipped anything', () => {
  const registry = { fake: () => ({ ...greenRaw(), collected: 10, passed: 9, skipped: 1, skipsByFile: { 'allowed/one.test.ts': 1 } }) }
  assert.equal(runAll(['fake'], { skipsData: null, registry }).fake.status, 'fail')
})
