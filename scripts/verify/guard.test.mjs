// TASK-045 (TRD-444): unit tests for lib/guard.mjs's evaluateSuite, the ONE
// place a suite's raw {collected, passed, failed, skipped} numbers become
// verify's pass/fail. Each `test()` below corresponds to one `if` in
// evaluateSuite; guard-efficacy is proved by commenting that `if` out in a
// SCRATCH COPY (never this file) and watching the matching case here flip
// from PASS to a silent, wrong PASS -- see the TASK-045 commit message for
// the dated RED/GREEN transcript of that proof.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateSuite } from './lib/guard.mjs'

test('missing tool fails before any count is consulted', () => {
  const r = evaluateSuite({ toolMissing: 'bats', collected: 999, passed: 999, failed: 0, skipped: 0 })
  assert.equal(r.status, 'fail')
  assert.match(r.reason, /missing tool: bats/)
})

test('unparseable output fails, never falls back to a pass', () => {
  const r = evaluateSuite({ unparseable: true, collected: 0, passed: 0, failed: 0, skipped: 0 })
  assert.equal(r.status, 'fail')
  assert.match(r.reason, /unparseable/)
})

test('zero collected tests fails even with a clean exit code shape', () => {
  const r = evaluateSuite({ collected: 0, passed: 0, failed: 0, skipped: 0 })
  assert.equal(r.status, 'fail')
  assert.match(r.reason, /collected 0 tests/)
})

test('a negative or non-finite collected count is treated as zero, not trusted', () => {
  assert.equal(evaluateSuite({ collected: -1 }).status, 'fail')
  assert.equal(evaluateSuite({ collected: Number.NaN }).status, 'fail')
})

test('any reported failure fails the suite regardless of skip bookkeeping', () => {
  const r = evaluateSuite({ collected: 10, passed: 8, failed: 2, skipped: 0, allowedSkips: 999 })
  assert.equal(r.status, 'fail')
  assert.match(r.reason, /2 of 10 failed/)
})

test('every collected test skipped fails even when under the allow-list max', () => {
  const r = evaluateSuite({ collected: 3, passed: 0, failed: 0, skipped: 3, allowedSkips: 10 })
  assert.equal(r.status, 'fail')
  assert.match(r.reason, /all 3 collected test\(s\) were skipped/)
})

test('a skip beyond the declared allowance fails, naming the allow-list file', () => {
  const r = evaluateSuite({ collected: 10, passed: 8, failed: 0, skipped: 2, allowedSkips: 1 })
  assert.equal(r.status, 'fail')
  assert.match(r.reason, /2 test\(s\) skipped, exceeds the allowed 1/)
  assert.match(r.reason, /allowed-skips\.json/)
})

test('a skip within the declared allowance passes', () => {
  const r = evaluateSuite({ collected: 10, passed: 9, failed: 0, skipped: 1, allowedSkips: 1 })
  assert.equal(r.status, 'pass')
  assert.equal(r.reason, null)
})

test('a per-file skip violation fails even when the suite-wide allowance would have permitted it (Q3)', () => {
  // Reproduces the real defect: allowedSkipsForSuite sums every entry's
  // maxCount into one suite-wide budget, so 21 skips concentrated entirely
  // in a file only ever allowed 1 still summed to <= 21 and passed.
  const r = evaluateSuite({
    collected: 100,
    passed: 79,
    failed: 0,
    skipped: 21,
    allowedSkips: 21,
    skipFileViolations: ['gremion-ui/scripts/install-git-hooks.test.ts: 21 skip(s), exceeds the allowed 1 for this file'],
  })
  assert.equal(r.status, 'fail')
  assert.match(r.reason, /unaccounted skip\(s\)/)
  assert.match(r.reason, /install-git-hooks/)
})

test('no skipFileViolations falls back to the suite-wide allowance unchanged', () => {
  const r = evaluateSuite({ collected: 10, passed: 9, failed: 0, skipped: 1, allowedSkips: 1, skipFileViolations: [] })
  assert.equal(r.status, 'pass')
})

test('a fully green suite with no skips at all passes', () => {
  const r = evaluateSuite({ collected: 42, passed: 42, failed: 0, skipped: 0 })
  assert.equal(r.status, 'pass')
})

test('defaults: calling with no args at all is a zero-collected fail, not a crash', () => {
  const r = evaluateSuite()
  assert.equal(r.status, 'fail')
  assert.match(r.reason, /collected 0 tests/)
})
