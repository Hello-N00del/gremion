// TASK-053 (G-053-wiring): boundary-lint's full-tree scan must actually run in
// verify. Nothing invoked `boundary-lint.ts --all` before TASK-053 (pre-commit
// runs `--staged`), so this pins both halves of the wiring, per the census
// precedent: the required-suites.txt line AND the SUITE_REGISTRY entry.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadRequiredSuites, SUITE_REGISTRY } from '../verify.mjs'
import { runBoundaryLintSuite } from './suite.mjs'

test('required-suites.txt names boundary-lint', () => {
  assert.ok(loadRequiredSuites().includes('boundary-lint'), 'required-suites.txt dropped "boundary-lint"')
})

test('SUITE_REGISTRY["boundary-lint"] is a synchronous runner', () => {
  const runner = SUITE_REGISTRY['boundary-lint']
  assert.equal(typeof runner, 'function', 'SUITE_REGISTRY has no runner for "boundary-lint"')
  assert.notEqual(runner.constructor.name, 'AsyncFunction', 'runAll() does not await its runners')
})

test('the boundary-lint runner is runBoundaryLintSuite, not a stand-in', () => {
  const runner = SUITE_REGISTRY['boundary-lint']
  assert.ok(runner === runBoundaryLintSuite || /runBoundaryLintSuite\(/.test(String(runner)))
})
