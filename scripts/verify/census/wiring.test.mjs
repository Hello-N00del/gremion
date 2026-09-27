// TASK-036: the census must actually run. meta.test.mjs pins only TASK-045's
// own suites; this file pins `census` -- both halves, because dropping either
// the required-suites.txt line or the SUITE_REGISTRY entry is exactly the
// shape that silently removes a guard (runAll reports a missing registry
// entry as its own FAIL, but a dropped required-suites.txt line is just a
// shorter run).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadRequiredSuites, SUITE_REGISTRY } from '../verify.mjs'
import { runCensusSuite } from './suite.mjs'

test('required-suites.txt names census', () => {
  assert.ok(loadRequiredSuites().includes('census'), 'required-suites.txt dropped "census"')
})

test('SUITE_REGISTRY.census is a runner', () => {
  assert.equal(typeof SUITE_REGISTRY.census, 'function', 'SUITE_REGISTRY has no runner for "census"')
  assert.notEqual(SUITE_REGISTRY.census.constructor.name, 'AsyncFunction', 'runAll() does not await its runners')
})

test('the census runner is runCensusSuite, not a stand-in', () => {
  assert.ok(SUITE_REGISTRY.census === runCensusSuite || /runCensusSuite/.test(String(SUITE_REGISTRY.census)))
})
